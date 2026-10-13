// Deterministic route builder. Given one truck and the current load list, it
// chains loads into feasible multi-load routes and ranks them by an explicit,
// dispatcher-chosen metric. No opaque scores: every number shown is arithmetic
// the dispatcher can check.

import { DEFAULT_TZ, HOUR, localHour, nextDayAt } from "./clock";
import { placeLabel, roadMiles } from "./geo";
import type {
  Load,
  Place,
  RouteCandidate,
  RouteLeg,
  RouteTotals,
  SortKey,
  Truck,
} from "./types";

export interface PlanOptions {
  now: number;
  tz?: string;
  sortBy?: SortKey;
  /** How many alternatives to return per truck. */
  maxAlternatives?: number;
  /** Next-load options explored at each step; bounds search cost. */
  branchWidth?: number;
}

interface SearchState {
  place: Place;
  readyAt: number;
  driveSinceRest: number;
  legs: RouteLeg[];
  used: Set<string>;
}

interface DriveResult {
  end: number;
  driveSinceRest: number;
  restStops: number;
}

/** Drive `miles` starting at `start`, inserting rest breaks per the truck's planning buffer. */
export function drive(
  start: number,
  miles: number,
  driveSinceRest: number,
  truck: Truck,
): DriveResult {
  const { avgSpeedMph, driveHoursBeforeRest, restHours } = truck.rules;
  let hoursLeft = miles / avgSpeedMph;
  let t = start;
  let sinceRest = driveSinceRest;
  let restStops = 0;
  while (hoursLeft > 1e-9) {
    const untilRest = driveHoursBeforeRest - sinceRest;
    if (hoursLeft <= untilRest) {
      t += hoursLeft * HOUR;
      sinceRest += hoursLeft;
      hoursLeft = 0;
    } else {
      t += (untilRest + restHours) * HOUR;
      hoursLeft -= untilRest;
      sinceRest = 0;
      restStops++;
    }
  }
  return { end: t, driveSinceRest: sinceRest, restStops };
}

/** Why a load can't be used by this truck at all, or null if it's eligible. */
export function ineligibleReason(load: Load, truck: Truck, now: number): string | null {
  const r = truck.rules;
  if (load.equipment !== truck.equipment) return "equipment";
  if (load.weightLbs !== null && load.weightLbs > truck.maxWeightLbs) return "overweight";
  if (load.lengthFt !== null && load.lengthFt > truck.trailerLengthFt) return "too long";
  if (r.avoidStates.includes(load.origin.state)) return "avoided pickup state";
  if (r.avoidStates.includes(load.destination.state)) return "avoided delivery state";
  if (load.pickupLatest < now) return "pickup window passed";
  if (load.rate === null && r.excludeLoadsWithoutRate) return "no posted rate";
  if (load.rate !== null && r.minLoadedRpm > 0) {
    const rpm = load.rate / loadedMilesOf(load).miles;
    if (rpm < r.minLoadedRpm) return "below minimum RPM";
  }
  return null;
}

function loadedMilesOf(load: Load): { miles: number; provenance: "source" | "estimated" } {
  if (load.tripMiles !== null && load.tripMiles > 0) {
    return { miles: load.tripMiles, provenance: "source" };
  }
  return { miles: Math.max(1, roadMiles(load.origin, load.destination)), provenance: "estimated" };
}

/** Plan one leg from the current state, or return null if it breaks a timing or distance rule. */
export function planLeg(
  state: Pick<SearchState, "place" | "readyAt" | "driveSinceRest">,
  load: Load,
  truck: Truck,
  tz: string,
): (RouteLeg & { driveSinceRest: number }) | null {
  const r = truck.rules;
  const notes: string[] = [];

  const deadheadMiles = roadMiles(state.place, load.origin);
  if (deadheadMiles > r.maxDeadheadMiles) return null;

  const toPickup = drive(state.readyAt, deadheadMiles, state.driveSinceRest, truck);
  const arriveAtPickup = toPickup.end;
  if (arriveAtPickup > load.pickupLatest) return null;

  const pickupStart = Math.max(arriveAtPickup, load.pickupEarliest);
  let sinceRest = toPickup.driveSinceRest;
  const waitHours = (pickupStart - arriveAtPickup) / HOUR;
  if (waitHours >= r.restHours) sinceRest = 0;
  if (waitHours >= 2) notes.push(`Waits ${Math.round(waitHours)}h for the pickup window`);
  const pickupDone = pickupStart + r.dwellHours * HOUR;

  const loaded = loadedMilesOf(load);
  if (loaded.provenance === "estimated") notes.push("Trip miles not posted; estimated");
  const toDelivery = drive(pickupDone, loaded.miles, sinceRest, truck);
  const arriveAtDelivery = toDelivery.end;
  if (load.deliveryLatest !== null && arriveAtDelivery > load.deliveryLatest) return null;

  const deliveryStart = Math.max(arriveAtDelivery, load.deliveryEarliest ?? arriveAtDelivery);
  sinceRest = toDelivery.driveSinceRest;
  if ((deliveryStart - arriveAtDelivery) / HOUR >= r.restHours) sinceRest = 0;
  const deliveryDone = deliveryStart + r.dwellHours * HOUR;

  let readyForNext = deliveryDone;
  if (r.noSameDayPickupAfterHour !== null && localHour(deliveryDone, tz) >= r.noSameDayPickupAfterHour) {
    readyForNext = nextDayAt(deliveryDone, r.nextDayStartHour, tz);
    if ((readyForNext - deliveryDone) / HOUR >= r.restHours) sinceRest = 0;
  }

  const restStops = toPickup.restStops + toDelivery.restStops;
  if (restStops > 0) notes.push(`${restStops} rest break${restStops > 1 ? "s" : ""} planned`);
  if (load.rate === null) notes.push("No rate posted; call broker");
  if (load.weightLbs === null) notes.push("Weight not posted");
  if (load.deliveryLatest === null) notes.push("No delivery appointment posted");

  return {
    load,
    deadheadMiles,
    loadedMiles: loaded.miles,
    loadedMilesProvenance: loaded.provenance,
    departForPickup: state.readyAt,
    arriveAtPickup,
    pickupStart,
    pickupDone,
    arriveAtDelivery,
    deliveryStart,
    deliveryDone,
    readyForNext,
    loadedRpm: load.rate === null ? null : load.rate / loaded.miles,
    notes,
    driveSinceRest: sinceRest,
  };
}

export function totalsFor(legs: RouteLeg[], startAt: number): RouteTotals {
  const last = legs[legs.length - 1]!;
  const revenue = legs.reduce((s, l) => s + (l.load.rate ?? 0), 0);
  const loadedMiles = legs.reduce((s, l) => s + l.loadedMiles, 0);
  const deadheadMiles = legs.reduce((s, l) => s + l.deadheadMiles, 0);
  const totalMiles = loadedMiles + deadheadMiles;
  const elapsedHours = (last.deliveryDone - startAt) / HOUR;
  return {
    revenue,
    revenueIncomplete: legs.some((l) => l.load.rate === null),
    loadedMiles,
    deadheadMiles,
    totalMiles,
    loadedRpm: loadedMiles > 0 ? revenue / loadedMiles : null,
    totalRpm: totalMiles > 0 ? revenue / totalMiles : null,
    revenuePerDay: elapsedHours > 0 ? revenue / (elapsedHours / 24) : 0,
    elapsedHours,
    finishAt: last.deliveryDone,
    finishPlace: last.load.destination,
  };
}

const sorters: Record<SortKey, (t: RouteTotals) => number> = {
  totalRpm: (t) => t.totalRpm ?? 0,
  revenue: (t) => t.revenue,
  revenuePerDay: (t) => t.revenuePerDay,
  leastDeadhead: (t) => -t.deadheadMiles,
};

/** Cheap look-ahead, in the same terms as the sort, used only to decide which branches to explore first. */
function branchValue(leg: RouteLeg, sortBy: SortKey): number {
  const rate = leg.load.rate ?? 0;
  switch (sortBy) {
    case "totalRpm":
      return rate / (leg.loadedMiles + leg.deadheadMiles);
    case "revenue":
      return rate;
    case "revenuePerDay":
      return rate / Math.max(1, leg.deliveryDone - leg.departForPickup);
    case "leastDeadhead":
      return -leg.deadheadMiles;
  }
}

export function planRoutes(truck: Truck, loads: Load[], opts: PlanOptions): RouteCandidate[] {
  const tz = opts.tz ?? DEFAULT_TZ;
  const sortBy = opts.sortBy ?? "revenuePerDay";
  const maxAlternatives = opts.maxAlternatives ?? 5;
  const branchWidth = opts.branchWidth ?? 10;
  const r = truck.rules;
  const startAt = Math.max(truck.availableAt, opts.now);

  const eligible = loads.filter((l) => ineligibleReason(l, truck, opts.now) === null);
  const complete: RouteLeg[][] = [];
  const partial: RouteLeg[][] = [];

  const explore = (state: SearchState) => {
    const depth = state.legs.length;
    if (depth >= r.maxLoadsPerRoute) return;
    const options: (RouteLeg & { driveSinceRest: number })[] = [];
    for (const load of eligible) {
      if (state.used.has(load.id)) continue;
      const leg = planLeg(state, load, truck, tz);
      if (leg) options.push(leg);
    }
    options.sort((a, b) => branchValue(b, sortBy) - branchValue(a, sortBy));
    // Explore wider at the first load so alternatives differ where it matters most.
    const width = depth === 0 ? branchWidth * 2 : branchWidth;
    for (const { driveSinceRest, ...leg } of options.slice(0, width)) {
      const legs = [...state.legs, leg];
      if (endsNearHome(legs, truck)) {
        (legs.length === r.maxLoadsPerRoute ? complete : partial).push(legs);
      }
      explore({
        place: leg.load.destination,
        readyAt: leg.readyForNext,
        driveSinceRest,
        legs,
        used: new Set(state.used).add(leg.load.id),
      });
    }
  };

  explore({ place: truck.location, readyAt: startAt, driveSinceRest: 0, legs: [], used: new Set() });

  const rank = (routes: RouteLeg[][]) =>
    routes
      .map((legs) => ({ legs, totals: totalsFor(legs, startAt) }))
      .sort((a, b) => sorters[sortBy](b.totals) - sorters[sortBy](a.totals));

  // Full-length plans come first; shorter ones only fill in when there aren't enough.
  const ranked = [...rank(complete), ...rank(partial)];
  // Two plans that run the same lanes in the same order read as duplicates to a
  // dispatcher even if the loads differ, so lanes, not load ids, decide "different".
  const lane = (l: RouteLeg) => `${placeLabel(l.load.origin)}>${placeLabel(l.load.destination)}`;
  const chosen: typeof ranked = [];
  const seenPaths = new Set<string>();
  const seenFirstLanes = new Set<string>();
  for (const pass of [true, false]) {
    for (const route of ranked) {
      if (chosen.length >= maxAlternatives) break;
      const path = route.legs.map(lane).join("|");
      if (seenPaths.has(path)) continue;
      // First pass: one alternative per starting lane, so options are genuinely different.
      const first = lane(route.legs[0]!);
      if (pass && seenFirstLanes.has(first)) continue;
      seenFirstLanes.add(first);
      seenPaths.add(path);
      chosen.push(route);
    }
  }

  return chosen.map(({ legs, totals }) => ({
    id: `${truck.id}:${legs.map((l) => l.load.id).join(">")}`,
    truckId: truck.id,
    legs,
    totals,
    flags: routeFlags(legs, totals, truck),
  }));
}

function endsNearHome(legs: RouteLeg[], truck: Truck): boolean {
  const { homeBase, maxMilesFromHomeAtEnd } = truck.rules;
  if (!homeBase || maxMilesFromHomeAtEnd === null) return true;
  const last = legs[legs.length - 1]!;
  return roadMiles(last.load.destination, homeBase) <= maxMilesFromHomeAtEnd;
}

function routeFlags(legs: RouteLeg[], totals: RouteTotals, truck: Truck): string[] {
  const flags: string[] = [];
  if (legs.length < truck.rules.maxLoadsPerRoute) {
    flags.push(`Only ${legs.length} of ${truck.rules.maxLoadsPerRoute} loads could be chained`);
  }
  const unrated = legs.filter((l) => l.load.rate === null).length;
  if (unrated > 0) {
    flags.push(`${unrated} load${unrated > 1 ? "s have" : " has"} no posted rate; revenue shown is a minimum`);
  }
  if (legs.some((l) => l.loadedMilesProvenance === "estimated")) {
    flags.push("Some trip miles are estimated");
  }
  const { homeBase } = truck.rules;
  if (homeBase) {
    flags.push(`Ends ${roadMiles(totals.finishPlace, homeBase)} mi from ${placeLabel(homeBase)}`);
  }
  return flags;
}
