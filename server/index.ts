// Server entry point: read settings, open the database (running migrations),
// pick the load source, start the API and the refresh scheduler.

import { buildApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db/client";
import { DatLoadSource } from "./loads/dat";
import type { LoadSource } from "./loads/source";
import { SyntheticLoadSource } from "./loads/synthetic";
import { startScheduler } from "./planning/refresh";

const config = loadConfig();
const { db, close } = await openDatabase({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
const source: LoadSource = config.LOAD_SOURCE === "dat"
  ? new DatLoadSource(config)
  : new SyntheticLoadSource(config.REFRESH_SECONDS * 1000);

const app = await buildApp({ db, config, source });
const stopScheduler = startScheduler({
  db,
  source,
  maxSearches: config.MAX_SEARCHES_PER_CYCLE,
  refreshMs: config.REFRESH_SECONDS * 1000,
  log: (msg, extra) => app.log.warn(extra ?? {}, msg),
});

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  stopScheduler();
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`Load source: ${source.name}. Database: ${config.DATABASE_URL ? "Postgres" : `embedded (${config.PGLITE_DIR})`}`);
