// All runtime settings come from environment variables so the same build runs
// locally, in tests and on any host. Secrets (database URL, DAT credentials)
// are only ever read from the environment, never from files in the repo.

import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("0.0.0.0"),
  /** Postgres connection string. When unset, an embedded Postgres (PGlite) stores data under PGLITE_DIR. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default(".data/pglite"),
  /** Where loads come from. "dat" stays off until DAT has approved access in writing. */
  LOAD_SOURCE: z.enum(["synthetic", "dat"]).default("synthetic"),
  /** Seconds between load refresh cycles for each company. */
  REFRESH_SECONDS: z.coerce.number().int().min(15).default(120),
  /** Upper bound on load-board searches per company per cycle (vendor rate limits). */
  MAX_SEARCHES_PER_CYCLE: z.coerce.number().int().min(1).default(40),
  /** Anyone can create a company account. Turn off once the pilot is set up. */
  ALLOW_SIGNUP: bool.default(true),
  SESSION_DAYS: z.coerce.number().int().min(1).default(14),
  /** Serve the built web app from this folder. */
  WEB_DIR: z.string().default("dist"),
  DAT_API_BASE: z.string().url().optional(),
  DAT_CLIENT_ID: z.string().optional(),
  DAT_CLIENT_SECRET: z.string().optional(),
  DAT_USERNAME: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
