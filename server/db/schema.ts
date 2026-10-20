// Database tables. Every row that belongs to a customer carries orgId, and
// every query filters on it: one dispatch company never sees another's trucks,
// loads or plans. Load-board data is stored per company because vendor
// licenses (DAT) are per subscriber and can't be shared across customers.

import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { Load, PlanningRules, Place, RouteCandidate } from "../../src/engine/types";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["owner", "dispatcher"] }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const sessions = pgTable("sessions", {
  /** SHA-256 of the cookie token; the token itself is never stored. */
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const trucks = pgTable("trucks", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  driver: text("driver").notNull().default(""),
  equipment: text("equipment", { enum: ["van", "reefer", "flatbed"] }).notNull(),
  location: jsonb("location").$type<Place>().notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  maxWeightLbs: integer("max_weight_lbs").notNull().default(45000),
  trailerLengthFt: integer("trailer_length_ft").notNull().default(53),
  rules: jsonb("rules").$type<PlanningRules>().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("trucks_org_idx").on(t.orgId)]);

export const loads = pgTable("loads", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  sourceId: text("source_id").notNull(),
  /** Canonical load record (engine shape, without id). */
  data: jsonb("data").$type<Omit<Load, "id">>().notNull(),
  pickupLatest: timestamp("pickup_latest", { withTimezone: true }).notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the board stops returning the load (covered or pulled). */
  goneAt: timestamp("gone_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("loads_org_source_idx").on(t.orgId, t.source, t.sourceId),
  index("loads_org_active_idx").on(t.orgId, t.goneAt),
]);

export const LOAD_MARKS = ["called", "booked", "rejected", "unavailable"] as const;
export type LoadMarkStatus = (typeof LOAD_MARKS)[number];

/** What a dispatcher did with a load. Booked, rejected and unavailable loads drop out of plans. */
export const loadMarks = pgTable("load_marks", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  loadId: uuid("load_id").notNull().references(() => loads.id, { onDelete: "cascade" }),
  status: text("status", { enum: LOAD_MARKS }).notNull(),
  truckId: uuid("truck_id").references(() => trucks.id, { onDelete: "set null" }),
  note: text("note").notNull().default(""),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("load_marks_org_load_idx").on(t.orgId, t.loadId)]);

export const plans = pgTable("plans", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  truckId: uuid("truck_id").notNull().references(() => trucks.id, { onDelete: "cascade" }),
  sortKey: text("sort_key").notNull(),
  rank: integer("rank").notNull(),
  route: jsonb("route").$type<RouteCandidate>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
}, (t) => [index("plans_org_truck_idx").on(t.orgId, t.truckId, t.sortKey)]);

/** One row per load refresh cycle, so operators can see failures instead of silently stale data. */
export const feedRuns = pgTable("feed_runs", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status", { enum: ["running", "ok", "error"] }).notNull(),
  searches: integer("searches").notNull().default(0),
  loadsSeen: integer("loads_seen").notNull().default(0),
  added: integer("added").notNull().default(0),
  removed: integer("removed").notNull().default(0),
  error: text("error"),
}, (t) => [index("feed_runs_org_idx").on(t.orgId, t.startedAt)]);

export const auditEvents = pgTable("audit_events", {
  id: id(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_org_idx").on(t.orgId, t.at)]);
