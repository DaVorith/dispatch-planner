// Decides which load-board searches to run in one refresh cycle.
//
// Planning multi-load routes needs loads near where each truck will be after
// its first and second loads, not only near where it is now. So searches fan
// out: first around each truck, then around where the best partial plans built
// from what came back would leave the truck, and so on, until the route depth
// or the search budget runs out. Identical searches (same equipment and market)
// are shared across trucks.

import { placeLabel, roadMiles } from "../../src/engine/geo";
import { planRoutes } from "../../src/engine/planner";
import type { Place, Truck } from "../../src/engine/types";
import type { LoadSearch, LoadSource, SourceLoad } from "./source";

const DAY = 24 * 3_600_000;
/** Look-ahead for pickups. Real boards rarely post more than a few days out. */
const HORIZON_DAYS = 5;
/** Next-leg markets explored per truck after each depth (routes plan up to 4 loads). */
const FAN_OUT = [5, 3, 2];
const MAX_DEPTH = 4;

export interface CollectResult {
  loads: SourceLoad[];
  searches: number;
  budgetExhausted: boolean;
}

export async function collectLoads(opts: {
  orgId: string;
  trucks: Truck[];
  source: LoadSource;
  now: number;
  maxSearches: number;
  signal?: AbortSignal;
}): Promise<CollectResult> {
  const { orgId, trucks, source, now, maxSearches, signal } = opts;
  const cache = new Map<string, SourceLoad[]>();
  let searches = 0;
  let budgetExhausted = false;

  const run = async (q: LoadSearch): Promise<SourceLoad[]> => {
    const key = `${q.equipment}|${placeLabel(q.origin)}|${q.radiusMiles}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (searches >= maxSearches) {
      budgetExhausted = true;
      return [];
    }
    searches++;
    const result = await source.search(orgId, q, signal);
    cache.set(key, result);
    return result;
  };

  // Breadth-first across trucks so a small budget is spread fairly instead of
  // being spent entirely on the first truck's deep searches.
  let frontier = trucks.map((t) => ({ truck: t, markets: [t.location], found: new Map<string, SourceLoad>() }));
  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { truck, markets, found } of frontier) {
      if (depth >= truck.rules.maxLoadsPerRoute) continue;
      const radius = truck.rules.maxDeadheadMiles;
      const fresh: SourceLoad[] = [];
      for (const market of markets) {
        const result = await run({
          equipment: truck.equipment,
          origin: market,
          radiusMiles: radius,
          pickupFrom: now,
          pickupTo: now + HORIZON_DAYS * DAY,
        });
        fresh.push(...result);
        for (const l of result) found.set(loadKey(l), l);
      }
      const fan = FAN_OUT[depth];
      if (!fan) continue;
      const picks = nextMarkets(truck, [...found.values()], now, depth + 1, fan, radius);
      // Fill any gap with the busiest drop markets, so a thin first search still spreads out.
      for (const p of topDestinations(fresh, fan, radius)) {
        if (picks.length >= fan) break;
        if (!picks.some((q) => roadMiles(q, p) < radius)) picks.push(p);
      }
      next.push({ truck, markets: picks, found });
    }
    frontier = next;
  }

  const all = new Map<string, SourceLoad>();
  for (const list of cache.values()) for (const l of list) all.set(loadKey(l), l);
  return { loads: [...all.values()], searches, budgetExhausted };
}

const loadKey = (l: SourceLoad) => `${l.source}|${l.sourceId}`;

/**
 * Where the truck would be empty after the best plans that can be built from
 * the loads found so far, counting only plans that use `legs` loads (the ones
 * that still need a next load searched for).
 */
function nextMarkets(truck: Truck, found: SourceLoad[], now: number, legs: number, count: number, mergeMiles: number): Place[] {
  const loads = found.map((l) => ({ ...l, id: loadKey(l) }));
  const routes = planRoutes({ ...truck, rules: { ...truck.rules, maxLoadsPerRoute: legs } }, loads, {
    now, maxAlternatives: count * 3,
  });
  // Alternate between the best-paying plans and the soonest-finishing ones: a
  // long haul often pays best but delivers after the board's posting horizon,
  // where a search finds nothing to reload with.
  const usable = routes.filter((r) => r.legs.length === legs);
  const soonest = [...usable].sort((a, b) => a.totals.finishAt - b.totals.finishAt);
  const picked: Place[] = [];
  for (let i = 0; i < usable.length && picked.length < count; i++) {
    for (const r of [usable[i]!, soonest[i]!]) {
      const end = r.totals.finishPlace;
      if (picked.length < count && !picked.some((p) => roadMiles(p, end) < mergeMiles)) picked.push(end);
    }
  }
  return picked;
}

/**
 * The drop markets most worth searching next: where the most paying loads
 * go, with drops closer than `mergeMiles` merged so we don't search the same area twice.
 */
export function topDestinations(loads: SourceLoad[], count: number, mergeMiles: number): Place[] {
  const tally = new Map<string, { place: Place; score: number }>();
  for (const l of loads) {
    const key = placeLabel(l.destination);
    const entry = tally.get(key) ?? { place: l.destination, score: 0 };
    entry.score += 1 + (l.rate ?? 0) / 1000;
    tally.set(key, entry);
  }
  const picked: Place[] = [];
  for (const { place } of [...tally.values()].sort((a, b) => b.score - a.score)) {
    if (picked.length >= count) break;
    if (picked.some((p) => roadMiles(p, place) < mergeMiles)) continue;
    picked.push(place);
  }
  return picked;
}
