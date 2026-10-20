import { and, eq, isNull } from "drizzle-orm";
import { CITIES, DEFAULT_RULES } from "../../src/engine/synthetic";
import type { Truck } from "../../src/engine/types";
import { loadConfig } from "../config";
import { openDatabase } from "../db/client";
import { loads, organizations } from "../db/schema";
import { collectLoads, topDestinations } from "./collector";
import { DatLoadSource, mapDatLoad } from "./dat";
import { type LoadSearch, type LoadSource, type SourceLoad, SourceNotConfiguredError } from "./source";
import { storeLoads } from "./store";

const city = (name: string) => CITIES.find((c) => c.city === name)!;
const NOW = Date.UTC(2026, 9, 20, 13);

function sourceLoad(id: string, from: string, to: string, rate: number | null = 1500): SourceLoad {
  return {
    sourceId: id, source: "synthetic", equipment: "van", origin: city(from), destination: city(to),
    pickupEarliest: NOW, pickupLatest: NOW + 4 * 3_600_000, deliveryEarliest: null, deliveryLatest: null,
    rate, tripMiles: 500, weightLbs: 40000, lengthFt: 53, broker: "B", brokerPhone: "", postedAt: NOW, commodity: null,
  };
}

const truck = (rules: Partial<Truck["rules"]> = {}): Truck => ({
  id: "t1", name: "T", driver: "", equipment: "van", location: city("Chicago"), availableAt: NOW,
  maxWeightLbs: 45000, trailerLengthFt: 53, rules: { ...DEFAULT_RULES, ...rules },
});

class RecordingSource implements LoadSource {
  readonly name = "synthetic" as const;
  calls: LoadSearch[] = [];
  constructor(private byCity: Record<string, SourceLoad[]>) {}
  async search(_org: string, q: LoadSearch) {
    this.calls.push(q);
    return this.byCity[q.origin.city] ?? [];
  }
}

describe("collectLoads", () => {
  const board = {
    Chicago: [sourceLoad("a", "Chicago", "Atlanta"), sourceLoad("b", "Chicago", "Dallas")],
    Atlanta: [sourceLoad("c", "Atlanta", "Memphis")],
    Dallas: [sourceLoad("d", "Dallas", "Houston")],
    Memphis: [sourceLoad("e", "Memphis", "Chicago")],
  };

  it("follows loads into the markets they deliver to", async () => {
    const src = new RecordingSource(board);
    const res = await collectLoads({ orgId: "o", trucks: [truck()], source: src, now: NOW, maxSearches: 50 });
    const searched = src.calls.map((c) => c.origin.city);
    expect(searched).toEqual(expect.arrayContaining(["Chicago", "Atlanta", "Dallas", "Memphis"]));
    expect(res.loads.map((l) => l.sourceId).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("shares identical searches between trucks and respects the budget", async () => {
    const src = new RecordingSource(board);
    await collectLoads({ orgId: "o", trucks: [truck(), { ...truck(), id: "t2" }], source: src, now: NOW, maxSearches: 50 });
    const keys = src.calls.map((c) => c.origin.city);
    expect(new Set(keys).size).toBe(keys.length);

    const limited = new RecordingSource(board);
    const res = await collectLoads({ orgId: "o", trucks: [truck()], source: limited, now: NOW, maxSearches: 2 });
    expect(limited.calls).toHaveLength(2);
    expect(res.budgetExhausted).toBe(true);
  });

  it("stops at the truck's route length", async () => {
    const src = new RecordingSource(board);
    await collectLoads({ orgId: "o", trucks: [truck({ maxLoadsPerRoute: 1 })], source: src, now: NOW, maxSearches: 50 });
    expect(src.calls.map((c) => c.origin.city)).toEqual(["Chicago"]);
  });

  it("merges nearby drop markets", () => {
    const picks = topDestinations([sourceLoad("x", "Atlanta", "Chicago"), sourceLoad("y", "Atlanta", "Joliet")], 2, 150);
    expect(picks).toHaveLength(1);
  });
});

describe("storeLoads", () => {
  it("adds new loads, refreshes seen ones and retires ones not seen for a while", async () => {
    const { db, close } = await openDatabase({ pgliteDir: "memory://" });
    const [org] = await db.insert(organizations).values({ name: "O" }).returning();
    const orgId = org!.id;
    const first = await storeLoads(db, orgId, [sourceLoad("a", "Chicago", "Atlanta"), sourceLoad("b", "Chicago", "Dallas")], NOW, 120_000);
    expect(first).toEqual({ added: 2, removed: 0 });

    // One cycle later only "a" is seen; "b" isn't gone yet (could be outside a search area).
    const second = await storeLoads(db, orgId, [sourceLoad("a", "Chicago", "Atlanta", 1700)], NOW + 60_000, 120_000);
    expect(second).toEqual({ added: 0, removed: 0 });
    const [a] = await db.select().from(loads).where(and(eq(loads.orgId, orgId), eq(loads.sourceId, "a")));
    expect(a!.data.rate).toBe(1700);

    // Three cycles later "b" still hasn't come back: retired.
    const third = await storeLoads(db, orgId, [sourceLoad("a", "Chicago", "Atlanta")], NOW + 180_000, 120_000);
    expect(third.removed).toBe(1);
    const active = await db.select({ id: loads.sourceId }).from(loads).where(and(eq(loads.orgId, orgId), isNull(loads.goneAt)));
    expect(active.map((r) => r.id)).toEqual(["a"]);
    await close();
  });
});

describe("DAT adapter", () => {
  const record = {
    id: "DAT-1", equipmentType: "V",
    origin: { city: "Chicago", state: "il" },
    destination: { city: "Somewhere", state: "TX", latitude: 31, longitude: -97 },
    pickupDateEarliest: "2026-10-21T13:00:00Z",
    rateUsd: 0, tripMiles: null, weightPounds: null,
    poster: { companyName: "Broker Co", phone: "555-0100" },
  };

  it("maps a record without inventing missing values", () => {
    const l = mapDatLoad(record, NOW)!;
    expect(l.source).toBe("dat");
    expect(l.equipment).toBe("van");
    expect(l.origin).toEqual(city("Chicago"));
    expect(l.destination).toEqual({ city: "Somewhere", state: "TX", lat: 31, lon: -97 });
    expect(l.rate).toBeNull();
    expect(l.tripMiles).toBeNull();
    expect(l.weightLbs).toBeNull();
    expect(l.pickupLatest - l.pickupEarliest).toBe(4 * 3_600_000);
  });

  it("skips records it can't plan with", () => {
    expect(mapDatLoad({ ...record, equipmentType: "TANKER" }, NOW)).toBeNull();
    expect(mapDatLoad({ ...record, origin: { city: "Nowhereville", state: "ZZ" } }, NOW)).toBeNull();
    expect(mapDatLoad({ ...record, pickupDateEarliest: "not a date" }, NOW)).toBeNull();
    expect(mapDatLoad({ nonsense: true }, NOW)).toBeNull();
  });

  it("refuses to start without credentials", () => {
    expect(() => new DatLoadSource(loadConfig({ LOAD_SOURCE: "dat" }))).toThrow(SourceNotConfiguredError);
  });

  it("signs in once, searches, maps results and reports rate limits", async () => {
    const cfg = loadConfig({ LOAD_SOURCE: "dat", DAT_API_BASE: "https://dat.example", DAT_CLIENT_ID: "id", DAT_CLIENT_SECRET: "secret" });
    const calls: string[] = [];
    let searchStatus = 200;
    const fakeFetch = (async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === "/token") return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      return new Response(JSON.stringify({ matches: [record, { bad: true }] }), { status: searchStatus });
    }) as typeof fetch;
    const src = new DatLoadSource(cfg, fakeFetch);
    const q: LoadSearch = { equipment: "van", origin: city("Chicago"), radiusMiles: 100, pickupFrom: NOW, pickupTo: NOW + 86_400_000 };
    expect(await src.search("o", q)).toHaveLength(1);
    await src.search("o", q);
    expect(calls).toEqual(["/token", "/search/loads", "/search/loads"]);
    searchStatus = 429;
    await expect(src.search("o", q)).rejects.toThrow(/rate limit/);
  });
});
