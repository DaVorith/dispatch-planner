// Server data source: trucks, plans and load marks come from the API, which
// refreshes loads on a schedule. The screen re-reads the board every 20
// seconds and right after any change the dispatcher makes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RouteCandidate, SortKey, Truck } from "../engine/types";
import { api } from "./api";
import type { BoardModel, LoadMark, MarkStatus } from "./model";

const POLL_MS = 20_000;

interface BoardResponse {
  now: number;
  trucks: Truck[];
  plans: Record<string, RouteCandidate[]>;
  marks: Record<string, LoadMark>;
  feed: {
    source: string;
    lastSuccessAt: number | null;
    lastAttemptAt: number | null;
    lastStatus: "running" | "ok" | "error" | null;
    lastError: string | null;
  };
  refreshSeconds: number;
}

export function useServerBoard(onSignedOut: () => void): BoardModel & { loading: boolean; loadError: string | null } {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>("revenuePerDay");
  const [now, setNow] = useState(Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const sortRef = useRef(sortBy);
  sortRef.current = sortBy;

  const load = useCallback(async () => {
    try {
      const res = await api<BoardResponse>(`/api/board?sort=${sortRef.current}`);
      setData(res);
      setLoadError(null);
    } catch (err) {
      if ((err as { status?: number }).status === 401) onSignedOut();
      else setLoadError(err instanceof Error ? err.message : "Couldn't reach the server");
    }
  }, [onSignedOut]);

  useEffect(() => { void load(); }, [load, sortBy]);
  useEffect(() => {
    const poll = setInterval(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const refresh = useCallback(async () => {
    await api("/api/refresh", { method: "POST", body: {} });
    await load();
  }, [load]);

  const saveTruck = useCallback(async (t: Truck, isNew: boolean) => {
    const { id: _id, ...body } = t;
    if (isNew) await api("/api/trucks", { method: "POST", body });
    else await api(`/api/trucks/${t.id}`, { method: "PUT", body });
    await load();
    // A moved or new truck needs fresh searches, which run in the background; check back shortly.
    setTimeout(() => void load(), 4000);
  }, [load]);

  const removeTruck = useCallback(async (id: string) => {
    await api(`/api/trucks/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  const setMark = useCallback(async (loadId: string, status: MarkStatus | null, truckId: string | null) => {
    if (status) await api(`/api/loads/${loadId}/mark`, { method: "PUT", body: { status, truckId } });
    else await api(`/api/loads/${loadId}/mark`, { method: "DELETE" });
    await load();
  }, [load]);

  const plans = useMemo(() => new Map(Object.entries(data?.plans ?? {})), [data]);
  const feed = data?.feed;
  const staleAfter = (data?.refreshSeconds ?? 120) * 3 * 1000;
  const lastRefreshed = feed?.lastSuccessAt ?? null;
  return {
    mode: "server",
    loading: data === null && loadError === null,
    loadError,
    trucks: data?.trucks ?? [],
    plans,
    marks: data?.marks ?? {},
    sortBy, setSortBy, now, lastRefreshed,
    stale: loadError !== null || (lastRefreshed !== null && now - lastRefreshed > staleAfter) || feed?.lastStatus === "error",
    feedError: loadError ?? (feed?.lastStatus === "error" ? feed.lastError : null),
    loadCount: null,
    refresh, saveTruck, removeTruck, setMark,
  };
}
