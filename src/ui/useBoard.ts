// Demo data source: a synthetic board in the browser, refreshed every minute,
// planned locally. Used for the shareable preview, which has no server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { planRoutes } from "../engine/planner";
import { churnLoadBoard, makeLoadBoard, rng, sampleTrucks } from "../engine/synthetic";
import type { Load, RouteCandidate, SortKey, Truck } from "../engine/types";
import type { BoardModel, LoadMark, MarkStatus } from "./model";

export const REFRESH_EVERY_MS = 60_000;
/** Plans older than this are shown as stale. */
export const STALE_AFTER_MS = 3 * 60_000;
const TRUCKS_KEY = "dispatch-planner:trucks:v1";
const EXCLUDING: MarkStatus[] = ["booked", "rejected", "unavailable"];

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

export function useDemoBoard(): BoardModel {
  const [startedAt] = useState(() => Date.now());
  const [rand] = useState(() => rng(startedAt));
  const [board, setBoard] = useState<Load[]>(() => makeLoadBoard(startedAt & 0xffff, startedAt));
  const [trucks, setTrucks] = useState<Truck[]>(() => loadSavedTrucks(startedAt));
  const [sortBy, setSortBy] = useState<SortKey>("revenuePerDay");
  const [now, setNow] = useState(startedAt);
  const [lastRefreshed, setLastRefreshed] = useState(startedAt);
  const [paused, setPaused] = useState(false);
  const [marks, setMarks] = useState<Record<string, LoadMark>>({});

  const boardRef = useRef(board);
  const refresh = useCallback(async () => {
    const t = Date.now();
    boardRef.current = churnLoadBoard(boardRef.current, rand, t);
    setBoard(boardRef.current);
    setLastRefreshed(t);
  }, [rand]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (paused) return;
    const loop = setInterval(() => void refresh(), REFRESH_EVERY_MS);
    return () => clearInterval(loop);
  }, [paused, refresh]);

  // Plans are rebuilt when the board refreshes or settings or marks change,
  // not every second, so they reflect the board as of `lastRefreshed`.
  const plans = useMemo(() => {
    const usable = board.filter((l) => !EXCLUDING.includes(marks[l.id]?.status as MarkStatus));
    const out = new Map<string, RouteCandidate[]>();
    for (const truck of trucks) out.set(truck.id, planRoutes(truck, usable, { now: lastRefreshed, sortBy }));
    return out;
  }, [trucks, board, sortBy, lastRefreshed, marks]);

  const saveTruck = useCallback(async (truck: Truck, isNew: boolean) => {
    setTrucks((prev) => {
      const next = isNew ? [...prev, { ...truck, id: `T${Date.now().toString(36)}` }] : prev.map((t) => (t.id === truck.id ? truck : t));
      saveTrucks(next);
      return next;
    });
  }, []);

  const removeTruck = useCallback(async (id: string) => {
    setTrucks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      saveTrucks(next);
      return next;
    });
  }, []);

  const setMark = useCallback(async (loadId: string, status: MarkStatus | null, truckId: string | null) => {
    setMarks((m) => {
      const next = { ...m };
      if (status) next[loadId] = { status, note: "", truckId, updatedAt: Date.now(), by: "You" };
      else delete next[loadId];
      return next;
    });
  }, []);

  return {
    mode: "demo",
    trucks, plans, marks, sortBy, setSortBy, now, lastRefreshed,
    stale: now - lastRefreshed > STALE_AFTER_MS,
    feedError: null,
    loadCount: board.length,
    refresh, saveTruck, removeTruck, setMark,
    demo: {
      paused,
      setPaused,
      resetTrucks: () => {
        const fresh = sampleTrucks(Date.now());
        saveTrucks(fresh);
        setTrucks(fresh);
        setMarks({});
      },
    },
  };
}
