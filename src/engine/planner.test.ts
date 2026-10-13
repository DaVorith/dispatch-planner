import { HOUR, localHour, nextDayAt, zonedTime } from "./clock";
import { roadMiles } from "./geo";
import { drive, ineligibleReason, planLeg, planRoutes, totalsFor } from "./planner";
import { CITIES, DEFAULT_RULES, makeLoadBoard, sampleTrucks } from "./synthetic";
import type { Load, Place, Truck } from "./types";

const TZ = "America/Chicago";
const city = (name: string): Place => CITIES.find((c) => c.city === name)!;
// Monday 2026-10-12 08:00 Chicago time.
const NOW = zonedTime(2026, 10, 12, 8, TZ);

function truck(overrides: Partial<Truck> = {}, rules: Partial<Truck["rules"]> = {}): Truck {
  return {
    id: "T1", name: "Truck 1", driver: "Test", equipment: "van",
    location: city("Chicago"), availableAt: NOW,
    maxWeightLbs: 45000, trailerLengthFt: 53,
    ...overrides,
    rules: { ...DEFAULT_RULES, ...rules },
  };
}

let n = 0;
function load(from: string, to: string, overrides: Partial<Load> = {}): Load {
  n++;
  return {
    id: `X${n}`, sourceId: `S${n}`, source: "synthetic", equipment: "van",
    origin: city(from), destination: city(to),
    pickupEarliest: NOW, pickupLatest: NOW + 48 * HOUR,
    deliveryEarliest: null, deliveryLatest: null,
    rate: 1000, tripMiles: 400, weightLbs: 40000, lengthFt: 53,
    broker: "B", brokerPhone: "", postedAt: NOW, commodity: null,
    ...overrides,
  };
}

describe("clock", () => {
  it("round-trips local wall-clock time", () => {
    expect(localHour(NOW, TZ)).toBe(8);
  });
  it("finds next morning in the planner timezone", () => {
    const next = nextDayAt(zonedTime(2026, 10, 12, 15, TZ), 6, TZ);
    expect(next).toBe(zonedTime(2026, 10, 13, 6, TZ));
  });
});

describe("drive", () => {
  it("adds a rest break after the drive-hour limit", () => {
    const t = truck();
    // 600 mi at 50 mph = 12h driving: 11h, 10h rest, 1h.
    const r = drive(NOW, 600, 0, t);
    expect(r.restStops).toBe(1);
    expect((r.end - NOW) / HOUR).toBeCloseTo(22);
    expect(r.driveSinceRest).toBeCloseTo(1);
  });
  it("carries drive hours across legs", () => {
    const r = drive(NOW, 100, 10, truck()); // 2h needed, 1h left before rest
    expect(r.restStops).toBe(1);
    expect((r.end - NOW) / HOUR).toBeCloseTo(12);
  });
});

describe("eligibility", () => {
  it("rejects wrong equipment, overweight, avoided states and low RPM", () => {
    const t = truck({}, { avoidStates: ["TX"], minLoadedRpm: 2 });
    expect(ineligibleReason(load("Chicago", "Atlanta", { equipment: "reefer" }), t, NOW)).toBe("equipment");
    expect(ineligibleReason(load("Chicago", "Atlanta", { weightLbs: 48000 }), t, NOW)).toBe("overweight");
    expect(ineligibleReason(load("Chicago", "Dallas"), t, NOW)).toBe("avoided delivery state");
    expect(ineligibleReason(load("Chicago", "Atlanta", { rate: 700 }), t, NOW)).toBe("below minimum RPM");
    expect(ineligibleReason(load("Chicago", "Atlanta", { rate: 900 }), t, NOW)).toBeNull();
  });
  it("keeps unrated loads unless the truck excludes them", () => {
    const l = load("Chicago", "Atlanta", { rate: null });
    expect(ineligibleReason(l, truck({}, { minLoadedRpm: 2 }), NOW)).toBeNull();
    expect(ineligibleReason(l, truck({}, { excludeLoadsWithoutRate: true }), NOW)).toBe("no posted rate");
  });
});

describe("planLeg", () => {
  const state = { place: city("Chicago"), readyAt: NOW, driveSinceRest: 0 };

  it("rejects pickups beyond max deadhead", () => {
    expect(planLeg(state, load("Indianapolis", "Atlanta"), truck({}, { maxDeadheadMiles: 100 }), TZ)).toBeNull();
    expect(planLeg(state, load("Joliet", "Atlanta"), truck({}, { maxDeadheadMiles: 100 }), TZ)).not.toBeNull();
  });

  it("rejects a pickup the truck can't reach before the window closes", () => {
    const l = load("Indianapolis", "Atlanta", { pickupLatest: NOW + 2 * HOUR });
    expect(planLeg(state, l, truck({}, { maxDeadheadMiles: 300 }), TZ)).toBeNull();
  });

  it("waits for a pickup window that opens later", () => {
    const l = load("Joliet", "Atlanta", { pickupEarliest: NOW + 6 * HOUR });
    const leg = planLeg(state, l, truck(), TZ)!;
    expect(leg.pickupStart).toBe(NOW + 6 * HOUR);
    expect(leg.notes.some((x) => x.startsWith("Waits"))).toBe(true);
  });

  it("rejects a delivery that would miss its appointment", () => {
    const l = load("Chicago", "Atlanta", { deliveryLatest: NOW + 5 * HOUR });
    expect(planLeg(state, l, truck(), TZ)).toBeNull();
  });

  it("pushes the next pickup to the next morning after an afternoon delivery", () => {
    // 100 loaded miles: pickup 08:00–10:00, drive 2h, unload 12:00–14:00 → past noon.
    const l = load("Chicago", "Milwaukee", { tripMiles: 100 });
    const leg = planLeg(state, l, truck(), TZ)!;
    expect(localHour(leg.deliveryDone, TZ)).toBe(14);
    expect(leg.readyForNext).toBe(zonedTime(2026, 10, 13, 6, TZ));

    const noRule = planLeg(state, l, truck({}, { noSameDayPickupAfterHour: null }), TZ)!;
    expect(noRule.readyForNext).toBe(noRule.deliveryDone);
  });

  it("estimates loaded miles when the posting has none, and says so", () => {
    const l = load("Chicago", "Atlanta", { tripMiles: null });
    const leg = planLeg(state, l, truck(), TZ)!;
    expect(leg.loadedMilesProvenance).toBe("estimated");
    expect(leg.loadedMiles).toBe(roadMiles(city("Chicago"), city("Atlanta")));
  });
});

describe("totals", () => {
  it("separates loaded RPM from total-mile RPM", () => {
    const t = truck();
    const leg = planLeg({ place: city("Joliet"), readyAt: NOW, driveSinceRest: 0 },
      load("Chicago", "Atlanta", { rate: 1500, tripMiles: 700 }), t, TZ)!;
    const totals = totalsFor([leg], NOW);
    expect(totals.revenue).toBe(1500);
    expect(totals.loadedRpm).toBeCloseTo(1500 / 700);
    expect(totals.totalRpm).toBeCloseTo(1500 / (700 + leg.deadheadMiles));
    expect(totals.totalMiles).toBe(700 + leg.deadheadMiles);
  });

  it("marks revenue incomplete when a load has no rate", () => {
    const t = truck();
    const leg = planLeg({ place: city("Chicago"), readyAt: NOW, driveSinceRest: 0 },
      load("Chicago", "Atlanta", { rate: null }), t, TZ)!;
    expect(totalsFor([leg], NOW).revenueIncomplete).toBe(true);
  });
});

describe("planRoutes", () => {
  it("chains loads in order, each pickup near the previous drop", () => {
    const t = truck();
    const loads = [
      load("Chicago", "Atlanta", { tripMiles: 715, rate: 1800 }),
      load("Atlanta", "Dallas", { tripMiles: 780, rate: 1900, pickupLatest: NOW + 96 * HOUR }),
      load("Dallas", "Chicago", { tripMiles: 925, rate: 2100, pickupLatest: NOW + 144 * HOUR }),
      load("Seattle", "Portland"),
    ];
    const routes = planRoutes(t, loads, { now: NOW, tz: TZ });
    const best = routes[0]!;
    expect(best.legs.map((l) => `${l.load.origin.city}>${l.load.destination.city}`)).toEqual([
      "Chicago>Atlanta", "Atlanta>Dallas", "Dallas>Chicago",
    ]);
    expect(best.totals.revenue).toBe(5800);
    for (let i = 1; i < best.legs.length; i++) {
      expect(best.legs[i]!.pickupStart).toBeGreaterThanOrEqual(best.legs[i - 1]!.readyForNext);
    }
  });

  it("returns several distinct alternatives on a real-size board", () => {
    const board = makeLoadBoard(42, NOW);
    for (const t of sampleTrucks(NOW)) {
      const routes = planRoutes(t, board, { now: NOW, tz: TZ });
      expect(routes.length).toBeGreaterThan(0);
      const lanes = (r: (typeof routes)[number]) =>
        r.legs.map((l) => `${l.load.origin.city}>${l.load.destination.city}`);
      // No two plans run the same lanes in the same order.
      expect(new Set(routes.map((r) => lanes(r).join("|"))).size).toBe(routes.length);
      // Distinct starting lanes come first; repeats only fill in when there aren't enough.
      const firsts = new Set(routes.map((r) => lanes(r)[0]));
      const leading = routes.slice(0, firsts.size).map((r) => lanes(r)[0]);
      expect(new Set(leading).size).toBe(firsts.size);
      for (const r of routes) {
        expect(r.legs.length).toBeLessThanOrEqual(t.rules.maxLoadsPerRoute);
        for (const leg of r.legs) {
          expect(ineligibleReason(leg.load, t, NOW)).toBeNull();
          expect(leg.deadheadMiles).toBeLessThanOrEqual(t.rules.maxDeadheadMiles);
          expect(leg.arriveAtPickup).toBeLessThanOrEqual(leg.load.pickupLatest);
        }
      }
    }
  });

  it("only ends near home when the truck asks for it", () => {
    const board = makeLoadBoard(7, NOW);
    const home = city("Columbus");
    const t = truck({ location: home }, { homeBase: home, maxMilesFromHomeAtEnd: 250 });
    for (const r of planRoutes(t, board, { now: NOW, tz: TZ })) {
      expect(roadMiles(r.totals.finishPlace, home)).toBeLessThanOrEqual(250);
    }
  });

  it("sorts by the chosen metric", () => {
    const board = makeLoadBoard(3, NOW);
    const t = sampleTrucks(NOW)[0]!;
    const byRevenue = planRoutes(t, board, { now: NOW, tz: TZ, sortBy: "revenue" });
    const full = byRevenue.filter((r) => r.legs.length === t.rules.maxLoadsPerRoute);
    for (let i = 1; i < full.length; i++) {
      expect(full[i - 1]!.totals.revenue).toBeGreaterThanOrEqual(full[i]!.totals.revenue);
    }
  });
});
