// Keeps each company's copy of the load board in step with the provider:
// new loads are added, ones still posted are refreshed, and ones the board
// stopped returning are marked gone so plans never offer covered freight.

import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { loads } from "../db/schema";
import type { SourceLoad } from "./source";

export interface StoreResult {
  added: number;
  removed: number;
}

/**
 * Upsert what this cycle saw and retire what hasn't been seen for `goneAfterMs`
 * (a load missing from one search might just be outside that search's area).
 */
export async function storeLoads(db: Db, orgId: string, seen: SourceLoad[], now: number, goneAfterMs: number): Promise<StoreResult> {
  const at = new Date(now);
  let added = 0;
  if (seen.length > 0) {
    const existing = new Set(
      (await db.select({ source: loads.source, sourceId: loads.sourceId }).from(loads)
        .where(and(eq(loads.orgId, orgId), inArray(loads.sourceId, seen.map((l) => l.sourceId)))))
        .map((r) => `${r.source}|${r.sourceId}`),
    );
    added = seen.filter((l) => !existing.has(`${l.source}|${l.sourceId}`)).length;
    for (let i = 0; i < seen.length; i += 500) {
      const batch = seen.slice(i, i + 500);
      await db.insert(loads).values(batch.map((l) => ({
        orgId,
        source: l.source,
        sourceId: l.sourceId,
        data: l,
        pickupLatest: new Date(l.pickupLatest),
        firstSeenAt: at,
        lastSeenAt: at,
      }))).onConflictDoUpdate({
        target: [loads.orgId, loads.source, loads.sourceId],
        set: {
          data: sql`excluded.data`,
          pickupLatest: sql`excluded.pickup_latest`,
          lastSeenAt: at,
          goneAt: null,
        },
      });
    }
  }
  const gone = await db.update(loads).set({ goneAt: at })
    .where(and(
      eq(loads.orgId, orgId),
      isNull(loads.goneAt),
      or(lt(loads.lastSeenAt, new Date(now - goneAfterMs)), lt(loads.pickupLatest, at)),
    ))
    .returning({ id: loads.id });
  return { added, removed: gone.length };
}
