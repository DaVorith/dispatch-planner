// HTTP API. Every route except health, signup and login needs a session, and
// every query is scoped to the signed-in user's company.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { and, eq, gt, inArray } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { RouteCandidate, SortKey } from "../src/engine/types";
import { AttemptLimiter, MIN_PASSWORD_LENGTH, hashPassword, newSessionToken, sessionIdFor, verifyPassword } from "./auth";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { LOAD_MARKS, auditEvents, loadMarks, loads, organizations, plans, sessions, trucks, users } from "./db/schema";
import type { LoadSource } from "./loads/source";
import { feedStatus, runCycle } from "./planning/refresh";
import { PLAN_SORTS, activeTrucks, rebuildPlans, toEngineTruck } from "./planning/service";

const COOKIE = "dp_session";

export interface AppDeps {
  db: Db;
  config: Config;
  source: LoadSource;
  now?: () => number;
}

interface SessionUser {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: "owner" | "dispatcher";
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

// ---------- input schemas ----------

const placeSchema = z.object({
  city: z.string().min(1).max(80),
  state: z.string().length(2).transform((s) => s.toUpperCase()),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const rulesSchema = z.object({
  minLoadedRpm: z.number().min(0).max(20),
  maxDeadheadMiles: z.number().int().min(0).max(1000),
  maxLoadsPerRoute: z.number().int().min(1).max(4),
  dwellHours: z.number().min(0).max(24),
  avgSpeedMph: z.number().min(20).max(70),
  driveHoursBeforeRest: z.number().min(1).max(24),
  restHours: z.number().min(0).max(48),
  noSameDayPickupAfterHour: z.number().int().min(0).max(23).nullable(),
  nextDayStartHour: z.number().int().min(0).max(23),
  avoidStates: z.array(z.string().length(2).transform((s) => s.toUpperCase())).max(60),
  homeBase: placeSchema.nullable(),
  maxMilesFromHomeAtEnd: z.number().int().min(0).max(3000).nullable(),
  excludeLoadsWithoutRate: z.boolean(),
});

const truckSchema = z.object({
  name: z.string().trim().min(1).max(60),
  driver: z.string().trim().max(60).default(""),
  equipment: z.enum(["van", "reefer", "flatbed"]),
  location: placeSchema,
  availableAt: z.number().int(),
  maxWeightLbs: z.number().int().min(1000).max(80000),
  trailerLengthFt: z.number().int().min(10).max(60),
  rules: rulesSchema,
});

const signupSchema = z.object({
  companyName: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

const addUserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  role: z.enum(["owner", "dispatcher"]).default("dispatcher"),
});

const markSchema = z.object({
  status: z.enum(LOAD_MARKS),
  note: z.string().max(500).default(""),
  truckId: z.string().uuid().nullable().default(null),
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(400, first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input");
  }
  return r.data;
}

const uuidParam = z.object({ id: z.string().uuid() });

// ---------- app ----------

export async function buildApp(deps: AppDeps) {
  const { db, config, source } = deps;
  const now = deps.now ?? Date.now;
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: "info" },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });
  const loginLimiter = new AttemptLimiter(8, 15 * 60_000);
  const refreshLimiter = new AttemptLimiter(1, 15_000);

  await app.register(cookie);
  app.decorateRequest("user", null);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on the server" });
  });

  app.addHook("onRequest", async (req) => {
    const token = req.cookies[COOKIE];
    if (!token) return;
    const [row] = await db.select({
      id: users.id, orgId: users.orgId, email: users.email, name: users.name, role: users.role,
    }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, sessionIdFor(token)), gt(sessions.expiresAt, new Date(now()))));
    req.user = row ?? null;
  });

  // Mutating requests must be JSON. Browsers can't send JSON cross-site without
  // a CORS preflight we never grant, which (with SameSite=Lax cookies) blocks CSRF.
  app.addHook("preValidation", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || !req.url.startsWith("/api/")) return;
    if (req.method === "DELETE" && !req.headers["content-type"]) return;
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      throw new HttpError(415, "Send requests as JSON");
    }
  });

  const requireUser = (req: FastifyRequest): SessionUser => {
    if (!req.user) throw new HttpError(401, "Please sign in");
    return req.user;
  };
  const requireOwner = (req: FastifyRequest): SessionUser => {
    const u = requireUser(req);
    if (u.role !== "owner") throw new HttpError(403, "Only an account owner can do that");
    return u;
  };
  const audit = (u: SessionUser, action: string, detail: Record<string, unknown> = {}) =>
    db.insert(auditEvents).values({ orgId: u.orgId, userId: u.id, action, detail });

  const startSession = async (reply: FastifyReply, userId: string) => {
    const { token, id } = newSessionToken();
    const expiresAt = new Date(now() + config.SESSION_DAYS * 86_400_000);
    await db.insert(sessions).values({ id, userId, expiresAt });
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.NODE_ENV === "production",
      expires: expiresAt,
    });
  };

  /** Kick off a background refresh (e.g. a truck moved); the next board fetch picks it up. */
  const refreshSoon = (orgId: string) => {
    void runCycle({
      db, source, orgId, now: now(), maxSearches: config.MAX_SEARCHES_PER_CYCLE, refreshMs: config.REFRESH_SECONDS * 1000,
    }).catch((err) => app.log.error(err));
  };

  // ---------- health & auth ----------

  app.get("/api/health", async () => ({ ok: true, source: source.name }));

  app.post("/api/auth/signup", async (req, reply) => {
    if (!config.ALLOW_SIGNUP) throw new HttpError(403, "New accounts are closed. Ask your account owner to add you.");
    const input = parse(signupSchema, req.body);
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (taken) throw new HttpError(409, "That email already has an account. Sign in instead.");
    const passwordHash = await hashPassword(input.password);
    const user = await db.transaction(async (tx) => {
      const [org] = await tx.insert(organizations).values({ name: input.companyName }).returning();
      const [u] = await tx.insert(users).values({
        orgId: org!.id, email: input.email, name: input.name, passwordHash, role: "owner",
      }).returning();
      return u!;
    });
    await startSession(reply, user.id);
    await db.insert(auditEvents).values({ orgId: user.orgId, userId: user.id, action: "account.created" });
    return { user: publicUser(user) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const input = parse(loginSchema, req.body);
    const key = `${input.email}|${req.ip}`;
    if (!loginLimiter.allow(key, now())) throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
    const [user] = await db.select().from(users).where(eq(users.email, input.email));
    // Verify against a dummy hash when the user doesn't exist so timing doesn't reveal accounts.
    const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, "Email or password is incorrect");
    loginLimiter.reset(key);
    await startSession(reply, user.id);
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.id, sessionIdFor(token)));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => {
    const u = requireUser(req);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, u.orgId));
    return { user: u, company: { id: org!.id, name: org!.name } };
  });

  // ---------- team ----------

  app.get("/api/users", async (req) => {
    const u = requireUser(req);
    const rows = await db.select().from(users).where(eq(users.orgId, u.orgId)).orderBy(users.name);
    return { users: rows.map(publicUser) };
  });

  app.post("/api/users", async (req) => {
    const owner = requireOwner(req);
    const input = parse(addUserSchema, req.body);
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
    if (taken) throw new HttpError(409, "That email already has an account");
    const [created] = await db.insert(users).values({
      orgId: owner.orgId, email: input.email, name: input.name, role: input.role,
      passwordHash: await hashPassword(input.password),
    }).returning();
    await audit(owner, "user.added", { email: input.email, role: input.role });
    return { user: publicUser(created!) };
  });

  // ---------- trucks ----------

  app.post("/api/trucks", async (req) => {
    const u = requireUser(req);
    const input = parse(truckSchema, req.body);
    const [row] = await db.insert(trucks).values({ ...input, orgId: u.orgId, availableAt: new Date(input.availableAt) }).returning();
    await audit(u, "truck.created", { truckId: row!.id, name: row!.name });
    refreshSoon(u.orgId);
    return { truck: toEngineTruck(row!) };
  });

  app.put("/api/trucks/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const input = parse(truckSchema, req.body);
    const [before] = await db.select().from(trucks).where(and(eq(trucks.id, id), eq(trucks.orgId, u.orgId), eq(trucks.active, true)));
    if (!before) throw new HttpError(404, "Truck not found");
    const [row] = await db.update(trucks)
      .set({ ...input, availableAt: new Date(input.availableAt), updatedAt: new Date(now()) })
      .where(and(eq(trucks.id, id), eq(trucks.orgId, u.orgId))).returning();
    await audit(u, "truck.updated", { truckId: id });
    // A new position or equipment needs fresh searches; other rule changes only need re-planning.
    const needsSearch = before.equipment !== input.equipment ||
      before.location.city !== input.location.city || before.location.state !== input.location.state ||
      before.rules.maxDeadheadMiles < input.rules.maxDeadheadMiles;
    if (needsSearch) refreshSoon(u.orgId);
    else await rebuildPlans(db, u.orgId, now(), [id]);
    return { truck: toEngineTruck(row!) };
  });

  app.delete("/api/trucks/:id", async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const [row] = await db.update(trucks).set({ active: false, updatedAt: new Date(now()) })
      .where(and(eq(trucks.id, id), eq(trucks.orgId, u.orgId))).returning({ id: trucks.id });
    if (!row) throw new HttpError(404, "Truck not found");
    await db.delete(plans).where(and(eq(plans.orgId, u.orgId), eq(plans.truckId, id)));
    await audit(u, "truck.removed", { truckId: id });
    return { ok: true };
  });

  // ---------- the board: everything the main screen needs in one call ----------

  app.get("/api/board", async (req) => {
    const u = requireUser(req);
    const { sort } = parse(z.object({ sort: z.enum(PLAN_SORTS as [SortKey, ...SortKey[]]).default("revenuePerDay") }), req.query);
    const truckRows = await activeTrucks(db, u.orgId);
    const planRows = await db.select({ truckId: plans.truckId, route: plans.route, computedAt: plans.computedAt }).from(plans)
      .where(and(eq(plans.orgId, u.orgId), eq(plans.sortKey, sort))).orderBy(plans.rank);
    const byTruck: Record<string, RouteCandidate[]> = {};
    for (const p of planRows) (byTruck[p.truckId] ??= []).push(p.route);
    const loadIds = [...new Set(planRows.flatMap((p) => p.route.legs.map((l) => l.load.id)))];
    const marks = loadIds.length
      ? await db.select({
        loadId: loadMarks.loadId, status: loadMarks.status, note: loadMarks.note, truckId: loadMarks.truckId,
        updatedAt: loadMarks.updatedAt, by: users.name,
      }).from(loadMarks).leftJoin(users, eq(users.id, loadMarks.userId))
        .where(and(eq(loadMarks.orgId, u.orgId), inArray(loadMarks.loadId, loadIds)))
      : [];
    return {
      now: now(),
      trucks: truckRows.map(toEngineTruck),
      plans: byTruck,
      marks: Object.fromEntries(marks.map((m) => [m.loadId, { ...m, updatedAt: m.updatedAt.getTime() }])),
      feed: await feedStatus(db, u.orgId, source.name),
      refreshSeconds: config.REFRESH_SECONDS,
    };
  });

  app.post("/api/refresh", async (req) => {
    const u = requireUser(req);
    if (!refreshLimiter.allow(u.orgId, now())) throw new HttpError(429, "A refresh just ran. Try again in a few seconds.");
    const run = await runCycle({
      db, source, orgId: u.orgId, now: now(), maxSearches: config.MAX_SEARCHES_PER_CYCLE, refreshMs: config.REFRESH_SECONDS * 1000,
    });
    return { started: run !== null, status: run?.status ?? "running", error: run?.error ?? null };
  });

  // ---------- load marks ----------

  app.put("/api/loads/:id/mark", async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    const input = parse(markSchema, req.body);
    const [load] = await db.select({ id: loads.id }).from(loads).where(and(eq(loads.id, id), eq(loads.orgId, u.orgId)));
    if (!load) throw new HttpError(404, "Load not found");
    if (input.truckId) {
      const [t] = await db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.id, input.truckId), eq(trucks.orgId, u.orgId)));
      if (!t) throw new HttpError(404, "Truck not found");
    }
    await db.insert(loadMarks).values({ orgId: u.orgId, loadId: id, ...input, userId: u.id, updatedAt: new Date(now()) })
      .onConflictDoUpdate({
        target: [loadMarks.orgId, loadMarks.loadId],
        set: { status: input.status, note: input.note, truckId: input.truckId, userId: u.id, updatedAt: new Date(now()) },
      });
    await audit(u, "load.marked", { loadId: id, status: input.status });
    await rebuildPlans(db, u.orgId, now());
    return { ok: true };
  });

  app.delete("/api/loads/:id/mark", async (req) => {
    const u = requireUser(req);
    const { id } = parse(uuidParam, req.params);
    await db.delete(loadMarks).where(and(eq(loadMarks.orgId, u.orgId), eq(loadMarks.loadId, id)));
    await audit(u, "load.unmarked", { loadId: id });
    await rebuildPlans(db, u.orgId, now());
    return { ok: true };
  });

  // ---------- web app ----------

  const webDir = resolve(config.WEB_DIR);
  if (existsSync(resolve(webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

function publicUser(u: typeof users.$inferSelect) {
  return { id: u.id, orgId: u.orgId, email: u.email, name: u.name, role: u.role };
}

// scrypt hash of a random string, used so failed logins for unknown emails take the same time.
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
