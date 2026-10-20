// Turns stored trucks and loads into ranked plans. Plans are computed for each
// money view the screen offers, stored, and served as-is, so opening the app
// never waits on the planner.

import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { planRoutes } from "../../src/engine/planner";
import type { Load, SortKey, Truck } from "../../src/engine/types";
import type { Db } from "../db/client";
import { loadMarks, loads, plans, trucks } from "../db/schema";

/** The rankings the UI offers. */
export const PLAN_SORTS: SortKey[] = ["revenuePerDay", "revenue"];
/** Marks that take a load out of every plan. "called" stays in. */
const EXCLUDING_MARKS = ["booked", "rejected", "unavailable"] as const;

export type TruckRow = typeof trucks.$inferSelect;

export function toEngineTruck(row: TruckRow): Truck {
  return {
    id: row.id,
    name: row.name,
    driver: row.driver,
    equipment: row.equipment,
    location: row.location,
    availableAt: row.availableAt.getTime(),
    maxWeightLbs: row.maxWeightLbs,
    trailerLengthFt: row.trailerLengthFt,
    rules: row.rules,
  };
}

export async function activeTrucks(db: Db, orgId: string): Promise<TruckRow[]> {
  return db.select().from(trucks).where(and(eq(trucks.orgId, orgId), eq(trucks.active, true))).orderBy(trucks.name);
}

/** Loads a plan may use: still posted, pickup not passed, not booked/rejected/unavailable. */
export async function plannableLoads(db: Db, orgId: string, now: number): Promise<Load[]> {
  const rows = await db.select({ id: loads.id, data: loads.data }).from(loads)
    .where(and(eq(loads.orgId, orgId), isNull(loads.goneAt), gt(loads.pickupLatest, new Date(now))));
  const excluded = new Set((await db.select({ loadId: loadMarks.loadId }).from(loadMarks)
    .where(and(eq(loadMarks.orgId, orgId), inArray(loadMarks.status, [...EXCLUDING_MARKS]))))
    .map((r) => r.loadId));
  return rows.filter((r) => !excluded.has(r.id)).map((r) => ({ ...r.data, id: r.id }));
}

/** Rebuild plans for some or all of a company's trucks. */
export async function rebuildPlans(db: Db, orgId: string, now: number, truckIds?: string[]): Promise<number> {
  const all = await activeTrucks(db, orgId);
  const targets = truckIds ? all.filter((t) => truckIds.includes(t.id)) : all;
  if (targets.length === 0) return 0;
  const board = await plannableLoads(db, orgId, now);
  const computedAt = new Date(now);
  const rows = targets.flatMap((t) => {
    const truck = toEngineTruck(t);
    return PLAN_SORTS.flatMap((sortBy) =>
      planRoutes(truck, board, { now, sortBy }).map((route, rank) => ({
        orgId, truckId: t.id, sortKey: sortBy, rank, route, computedAt,
      })));
  });
  await db.transaction(async (tx) => {
    await tx.delete(plans).where(and(eq(plans.orgId, orgId), inArray(plans.truckId, targets.map((t) => t.id))));
    if (rows.length) await tx.insert(plans).values(rows);
  });
  return rows.length;
}
