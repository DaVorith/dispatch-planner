// One database handle for the app. Production uses a real Postgres via
// DATABASE_URL; local development and tests fall back to PGlite, an embedded
// Postgres, so nothing needs installing to run the server.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  db: Db;
  close: () => Promise<void>;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Open the database and bring its schema up to date.
 * `pgliteDir` of "memory://" gives a throwaway in-memory database (tests).
 */
export async function openDatabase(opts: { url?: string; pgliteDir: string; migrationsDir?: string }): Promise<Database> {
  const migrationsFolder = opts.migrationsDir ?? MIGRATIONS;
  if (opts.url) {
    const pool = new pg.Pool({ connectionString: opts.url, max: 10 });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder });
    return { db: db as unknown as Db, close: () => pool.end() };
  }
  if (!opts.pgliteDir.startsWith("memory://")) mkdirSync(opts.pgliteDir, { recursive: true });
  const client = new PGlite(opts.pgliteDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder });
  return { db: db as unknown as Db, close: () => client.close() };
}
