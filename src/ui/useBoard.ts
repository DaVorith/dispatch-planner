// App state for the prototype: trucks, the (synthetic) load board, a refresh
// loop that mimics a live feed, and the route plans derived from them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { planRoutes } from "../engine/planner";
import { churnLoadBoard, makeLoadBoard, rng, sampleTrucks } from "../engine/synthetic";
import type { Load, RouteCandidate, SortKey, Truck } from "../engine/types";

export const REFRESH_EVERY_MS = 60_000;
/** Plans older than this are shown as stale. */
export const STALE_AFTER_MS = 3 * 60_000;
const TRUCKS_KEY = "dispatch-planner:trucks:v1";

function loadSavedTrucks(now: number): Truck[] {
  try {
    const raw = localStorage.getItem(TRUCKS_KEY);
    if (raw) return JSON.parse(raw) as Truck[];
  } catch {
    // No storage (private window, preview): start from the sample fleet.
  }
  return sampleTrucks(now);
}

function saveTrucks(trucks: Truck[]) {
  try {
    localStorage.setItem(TRUCKS_KEY, JSON.stringify(trucks));
  } catch {
    // Settings still apply for this visit.
  }
}

export interface FeedState {
  paused: boolean;
  lastRefreshed: number;
  refreshCount: number;
  added: number;
  removed: number;
}

export function useBoard() {
  const [startedAt] = useState(() => Date.now());
  const [rand] = useState(() => rng(startedAt));
  const [board, setBoard] = useState<Load[]>(() => makeLoadBoard(startedAt & 0xffff, startedAt));
  const [trucks, setTrucks] = useState<Truck[]>(() => loadSavedTrucks(startedAt));
  const [sortBy, setSortBy] = useState<SortKey>("revenuePerDay");
  const [now, setNow] = useState(startedAt);
  const [feed, setFeed] = useState<FeedState>({
    paused: false, lastRefreshed: startedAt, refreshCount: 0, added: 0, removed: 0,
  });

  const boardRef = useRef(board);
  const refresh = useCallback(() => {
    const t = Date.now();
    const prev = boardRef.current;
    const next = churnLoadBoard(prev, rand, t);
    const prevIds = new Set(prev.map((l) => l.id));
    const nextIds = new Set(next.map((l) => l.id));
    boardRef.current = next;
    setBoard(next);
    setFeed((f) => ({
      ...f,
      lastRefreshed: t,
      refreshCount: f.refreshCount + 1,
      added: next.filter((l) => !prevIds.has(l.id)).length,
      removed: prev.filter((l) => !nextIds.has(l.id)).length,
    }));
  }, [rand]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (feed.paused) return;
    const loop = setInterval(refresh, REFRESH_EVERY_MS);
    return () => clearInterval(loop);
  }, [feed.paused, refresh]);

  // Plans are rebuilt when the board refreshes or a truck's settings change,
  // not every second, so they reflect the board as of `lastRefreshed`.
  const plans = useMemo(() => {
    const out = new Map<string, RouteCandidate[]>();
    for (const truck of trucks) {
      out.set(truck.id, planRoutes(truck, board, { now: feed.lastRefreshed, sortBy }));
    }
    return out;
  }, [trucks, board, sortBy, feed.lastRefreshed]);

  const updateTruck = useCallback((truck: Truck) => {
    setTrucks((prev) => {
      const next = prev.map((t) => (t.id === truck.id ? truck : t));
      saveTrucks(next);
      return next;
    });
  }, []);

  const resetTrucks = useCallback(() => {
    const fresh = sampleTrucks(Date.now());
    saveTrucks(fresh);
    setTrucks(fresh);
  }, []);

  const setPaused = useCallback((paused: boolean) => setFeed((f) => ({ ...f, paused })), []);

  return {
    board, trucks, plans, sortBy, setSortBy, now, feed,
    stale: now - feed.lastRefreshed > STALE_AFTER_MS,
    refresh, setPaused, updateTruck, resetTrucks,
  };
}
