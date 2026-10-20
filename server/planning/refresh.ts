// One refresh cycle for one company: search the board, store what came back,
// retire what's gone, rebuild plans, and record how it went. A failed search
// leaves the previous loads and plans in place and is recorded, so the screen
// can say the data is stale instead of quietly showing old plans as current.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { feedRuns, trucks } from "../db/schema";
import { collectLoads } from "../loads/collector";
import type { LoadSource } from "../loads/source";
import { storeLoads } from "../loads/store";
import { activeTrucks, rebuildPlans, toEngineTruck } from "./service";

export interface CycleOptions {
  db: Db;
  source: LoadSource;
  orgId: string;
  now: number;
  maxSearches: number;
  refreshMs: number;
  signal?: AbortSignal;
}

export type FeedRun = typeof feedRuns.$inferSelect;

const running = new Set<string>();

/** Run a cycle unless one is already running for this company. Returns null when skipped. */
export async function runCycle(o: CycleOptions): Promise<FeedRun | null> {
  if (running.has(o.orgId)) return null;
  running.add(o.orgId);
  const [run] = await o.db.insert(feedRuns)
    .values({ orgId: o.orgId, source: o.source.name, startedAt: new Date(o.now), status: "running" })
    .returning();
  try {
    const truckRows = await activeTrucks(o.db, o.orgId);
    const collected = await collectLoads({
      orgId: o.orgId,
      trucks: truckRows.map(toEngineTruck),
      source: o.source,
      now: o.now,
      maxSearches: o.maxSearches,
      signal: o.signal,
    });
    // A load can drop out of one cycle's searches without being covered, so give it two cycles.
    const stored = await storeLoads(o.db, o.orgId, collected.loads, o.now, 2 * o.refreshMs + 1000);
    await rebuildPlans(o.db, o.orgId, o.now);
    const [done] = await o.db.update(feedRuns).set({
      status: "ok",
      finishedAt: new Date(),
      searches: collected.searches,
      loadsSeen: collected.loads.length,
      added: stored.added,
      removed: stored.removed,
      error: collected.budgetExhausted ? "Search budget reached; some markets were not searched this cycle" : null,
    }).where(eq(feedRuns.id, run!.id)).returning();
    return done!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [failed] = await o.db.update(feedRuns)
      .set({ status: "error", finishedAt: new Date(), error: message })
      .where(eq(feedRuns.id, run!.id)).returning();
    return failed!;
  } finally {
    running.delete(o.orgId);
  }
}

export interface FeedStatus {
  source: string;
  /** Last cycle that finished successfully; plans are as of this time. */
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastStatus: "running" | "ok" | "error" | null;
  lastError: string | null;
  added: number;
  removed: number;
}

export async function feedStatus(db: Db, orgId: string, sourceName: string): Promise<FeedStatus> {
  const [last] = await db.select().from(feedRuns).where(eq(feedRuns.orgId, orgId)).orderBy(desc(feedRuns.startedAt)).limit(1);
  const [ok] = await db.select().from(feedRuns)
    .where(and(eq(feedRuns.orgId, orgId), eq(feedRuns.status, "ok")))
    .orderBy(desc(feedRuns.startedAt)).limit(1);
  return {
    source: sourceName,
    lastSuccessAt: ok?.finishedAt?.getTime() ?? null,
    lastAttemptAt: last?.startedAt.getTime() ?? null,
    lastStatus: last?.status ?? null,
    lastError: last?.error ?? null,
    added: ok?.added ?? 0,
    removed: ok?.removed ?? 0,
  };
}

/** Companies that have at least one active truck, i.e. something to refresh. */
export async function orgsWithTrucks(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ orgId: trucks.orgId }).from(trucks).where(eq(trucks.active, true));
  return rows.map((r) => r.orgId);
}

/** Keep only the last week of cycle records. */
export async function pruneFeedRuns(db: Db, now: number) {
  await db.delete(feedRuns).where(sql`${feedRuns.startedAt} < ${new Date(now - 7 * 86_400_000)}`);
}

/**
 * Refresh every company on a fixed interval. Designed for a single server
 * instance; running several would need a shared lock (see docs/DEPLOY.md).
 */
export function startScheduler(o: Omit<CycleOptions, "orgId" | "now"> & { log: (msg: string, extra?: object) => void }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const now = Date.now();
      for (const orgId of await orgsWithTrucks(o.db)) {
        if (stopped) break;
        const run = await runCycle({ ...o, orgId, now: Date.now() });
        if (run?.status === "error") o.log("Load refresh failed", { orgId, error: run.error });
      }
      await pruneFeedRuns(o.db, now);
    } catch (err) {
      o.log("Scheduler tick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const timer = setInterval(tick, o.refreshMs);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
