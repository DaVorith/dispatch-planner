import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { CITIES, DEFAULT_RULES } from "../src/engine/synthetic";
import type { RouteCandidate } from "../src/engine/types";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { type Database, openDatabase } from "./db/client";
import { loads } from "./db/schema";
import type { LoadSearch, LoadSource, SourceLoad } from "./loads/source";
import { SyntheticLoadSource } from "./loads/synthetic";
import { runCycle } from "./planning/refresh";

const city = (name: string) => CITIES.find((c) => c.city === name)!;
const config = loadConfig({ NODE_ENV: "test", WEB_DIR: "does-not-exist", REFRESH_SECONDS: "60" });

/** Wraps the synthetic board so a test can make the provider fail on demand. */
class FlakySource implements LoadSource {
  readonly name = "synthetic" as const;
  fail = false;
  calls: LoadSearch[] = [];
  constructor(private inner = new SyntheticLoadSource(60_000)) {}
  async search(orgId: string, q: LoadSearch): Promise<SourceLoad[]> {
    this.calls.push(q);
    if (this.fail) throw new Error("Provider unavailable");
    return this.inner.search(orgId, q);
  }
}

let database: Database;
let app: FastifyInstance;
let source: FlakySource;

beforeEach(async () => {
  database = await openDatabase({ pgliteDir: "memory://" });
  source = new FlakySource();
  app = await buildApp({ db: database.db, config, source });
});
afterEach(async () => {
  await app.close();
  await database.close();
});

async function signup(email: string, company = "Acme Dispatch") {
  const res = await app.inject({
    method: "POST", url: "/api/auth/signup",
    payload: { companyName: company, name: "Owner", email, password: "correct horse battery" },
  });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === "dp_session")!;
  return { cookie: `dp_session=${cookie.value}`, user: res.json().user as { orgId: string } };
}

const truckBody = (overrides: Record<string, unknown> = {}) => ({
  name: "Truck 1", driver: "Pat", equipment: "van", location: city("Chicago"),
  availableAt: Date.now(), maxWeightLbs: 45000, trailerLengthFt: 53, rules: DEFAULT_RULES, ...overrides,
});

async function addTruck(cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/trucks", headers: { cookie }, payload: truckBody(overrides) });
  expect(res.statusCode).toBe(200);
  return res.json().truck as { id: string };
}

async function board(cookie: string) {
  const res = await app.inject({ method: "GET", url: "/api/board", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    trucks: { id: string }[];
    plans: Record<string, RouteCandidate[]>;
    marks: Record<string, { status: string }>;
    feed: { lastStatus: string | null; lastSuccessAt: number | null; lastError: string | null };
  };
}

const cycle = (orgId: string) =>
  runCycle({ db: database.db, source, orgId, now: Date.now(), maxSearches: 40, refreshMs: 60_000 });

describe("accounts", () => {
  it("signs up, reads the session, signs out", async () => {
    const { cookie } = await signup("owner@acme.test");
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.json().company.name).toBe("Acme Dispatch");
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "content-type": "application/json" }, payload: {} });
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("rejects duplicate emails, short passwords and wrong passwords", async () => {
    await signup("owner@acme.test");
    const dup = await app.inject({ method: "POST", url: "/api/auth/signup",
      payload: { companyName: "X", name: "Y", email: "OWNER@acme.test", password: "another long one" } });
    expect(dup.statusCode).toBe(409);
    const short = await app.inject({ method: "POST", url: "/api/auth/signup",
      payload: { companyName: "X", name: "Y", email: "new@acme.test", password: "short" } });
    expect(short.statusCode).toBe(400);
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "owner@acme.test", password: "not the password" } });
    expect(wrong.statusCode).toBe(401);
    const right = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "owner@acme.test", password: "correct horse battery" } });
    expect(right.statusCode).toBe(200);
  });

  it("locks out repeated failed sign-ins", async () => {
    await signup("owner@acme.test");
    let last = 0;
    for (let i = 0; i < 9; i++) {
      last = (await app.inject({ method: "POST", url: "/api/auth/login",
        payload: { email: "owner@acme.test", password: "wrong password" } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it("lets an owner add a dispatcher, but not a dispatcher add users", async () => {
    const { cookie } = await signup("owner@acme.test");
    const add = await app.inject({ method: "POST", url: "/api/users", headers: { cookie },
      payload: { name: "Dee", email: "dee@acme.test", password: "dispatcher pass 1" } });
    expect(add.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/auth/login",
      payload: { email: "dee@acme.test", password: "dispatcher pass 1" } });
    const dee = `dp_session=${login.cookies.find((c) => c.name === "dp_session")!.value}`;
    const denied = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: dee },
      payload: { name: "Z", email: "z@acme.test", password: "another long pass" } });
    expect(denied.statusCode).toBe(403);
  });

  it("refuses non-JSON writes (cross-site form posts)", async () => {
    const { cookie } = await signup("owner@acme.test");
    const res = await app.inject({ method: "POST", url: "/api/trucks",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "name=x" });
    expect(res.statusCode).toBe(415);
  });
});

describe("companies are isolated", () => {
  it("never shows or changes another company's trucks, plans or loads", async () => {
    const a = await signup("a@one.test", "One");
    const b = await signup("b@two.test", "Two");
    const truckA = await addTruck(a.cookie);
    await cycle(a.user.orgId);

    const boardB = await board(b.cookie);
    expect(boardB.trucks).toHaveLength(0);
    expect(Object.keys(boardB.plans)).toHaveLength(0);

    const edit = await app.inject({ method: "PUT", url: `/api/trucks/${truckA.id}`, headers: { cookie: b.cookie }, payload: truckBody({ name: "Stolen" }) });
    expect(edit.statusCode).toBe(404);
    const del = await app.inject({ method: "DELETE", url: `/api/trucks/${truckA.id}`, headers: { cookie: b.cookie } });
    expect(del.statusCode).toBe(404);

    const loadId = (await board(a.cookie)).plans[truckA.id]![0]!.legs[0]!.load.id;
    const mark = await app.inject({ method: "PUT", url: `/api/loads/${loadId}/mark`, headers: { cookie: b.cookie }, payload: { status: "booked" } });
    expect(mark.statusCode).toBe(404);
  });
});

describe("refresh and planning", () => {
  it("searches around the truck and its likely next markets, then stores plans", async () => {
    const { cookie, user } = await signup("owner@acme.test");
    const truck = await addTruck(cookie);
    source.calls = [];
    const run = await cycle(user.orgId);
    expect(run?.status).toBe("ok");
    expect(source.calls.length).toBeGreaterThan(1);
    expect(source.calls.some((c) => c.origin.city !== "Chicago")).toBe(true);

    const b = await board(cookie);
    const routes = b.plans[truck.id]!;
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((r) => r.legs.length > 1)).toBe(true);
    const ids = routes.flatMap((r) => r.legs.map((l) => l.load.id));
    const stored = await database.db.select({ id: loads.id }).from(loads).where(eq(loads.orgId, user.orgId));
    const storedIds = new Set(stored.map((r) => r.id));
    expect(ids.every((id) => storedIds.has(id))).toBe(true);
    expect(b.feed.lastStatus).toBe("ok");
  });

  it("drops rejected and booked loads from plans and brings them back when unmarked", async () => {
    const { cookie, user } = await signup("owner@acme.test");
    const truck = await addTruck(cookie);
    await cycle(user.orgId);
    const first = (await board(cookie)).plans[truck.id]![0]!.legs[0]!.load.id;

    const res = await app.inject({ method: "PUT", url: `/api/loads/${first}/mark`, headers: { cookie }, payload: { status: "rejected", note: "Broker won't pay" } });
    expect(res.statusCode).toBe(200);
    const after = await board(cookie);
    expect(after.plans[truck.id]!.flatMap((r) => r.legs.map((l) => l.load.id))).not.toContain(first);

    await app.inject({ method: "PUT", url: `/api/loads/${first}/mark`, headers: { cookie }, payload: { status: "called" } });
    const called = await board(cookie);
    expect(called.plans[truck.id]!.flatMap((r) => r.legs.map((l) => l.load.id))).toContain(first);
    expect(called.marks[first]?.status).toBe("called");

    await app.inject({ method: "DELETE", url: `/api/loads/${first}/mark`, headers: { cookie } });
    expect((await board(cookie)).marks[first]).toBeUndefined();
  });

  it("keeps the last good plans and reports the failure when the provider is down", async () => {
    const { cookie, user } = await signup("owner@acme.test");
    const truck = await addTruck(cookie);
    await cycle(user.orgId);
    const good = await board(cookie);

    source.fail = true;
    const run = await cycle(user.orgId);
    expect(run?.status).toBe("error");
    const after = await board(cookie);
    expect(after.feed.lastStatus).toBe("error");
    expect(after.feed.lastError).toContain("Provider unavailable");
    expect(after.feed.lastSuccessAt).toBe(good.feed.lastSuccessAt);
    expect(after.plans[truck.id]!.length).toBe(good.plans[truck.id]!.length);
  });

  it("re-plans immediately when a rule changes", async () => {
    const { cookie, user } = await signup("owner@acme.test");
    const truck = await addTruck(cookie);
    await cycle(user.orgId);
    const res = await app.inject({ method: "PUT", url: `/api/trucks/${truck.id}`, headers: { cookie },
      payload: truckBody({ rules: { ...DEFAULT_RULES, maxLoadsPerRoute: 1 } }) });
    expect(res.statusCode).toBe(200);
    const b = await board(cookie);
    expect(b.plans[truck.id]!.every((r) => r.legs.length === 1)).toBe(true);
  });

  it("removes a truck and its plans", async () => {
    const { cookie, user } = await signup("owner@acme.test");
    const truck = await addTruck(cookie);
    await cycle(user.orgId);
    await app.inject({ method: "DELETE", url: `/api/trucks/${truck.id}`, headers: { cookie } });
    const b = await board(cookie);
    expect(b.trucks).toHaveLength(0);
    expect(b.plans[truck.id]).toBeUndefined();
  });

  it("validates truck input", async () => {
    const { cookie } = await signup("owner@acme.test");
    const res = await app.inject({ method: "POST", url: "/api/trucks", headers: { cookie },
      payload: truckBody({ equipment: "tanker" }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("equipment");
  });
});
