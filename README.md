# Dispatch Route Planner

Builds multi-load route plans for each truck from load-board data and shows them side by side so a dispatcher can pick one, call the broker and book. Booking stays manual.

## Status

Working app on sample loads: company accounts and sign-in, trucks and their rules, scheduled load refresh, server-side planning, and Called/Booked/Rejected/Gone marks. DAT integration waits on written API approval (`LOAD_SOURCE=dat` stays off until then). Distances are straight-line × 1.18 until a routing provider is added. Rest breaks are a planning buffer, not an HOS check.

## Layout

- `src/engine/` – deterministic planning: data model (`types.ts`), feasibility and route search (`planner.ts`), synthetic board (`synthetic.ts`), timezone helpers (`clock.ts`). No UI code.
- `src/ui/` – React screens. `useServerBoard` reads the API; `useDemoBoard` plans sample loads in the browser for the shareable demo build.
- `server/` – Fastify API and refresh loop.
  - `db/` – Drizzle schema and migrations (Postgres, or embedded PGlite when `DATABASE_URL` is unset).
  - `loads/` – load sources (`synthetic.ts`, `dat.ts`), the search fan-out (`collector.ts`) and the per-company load store (`store.ts`).
  - `planning/` – plan rebuilding and the refresh scheduler.
- `docs/DEPLOY.md` – hosting, environment variables, switching to DAT.

## Commands

```
npm install
npm run dev:server   # API on :8080
npm run dev          # screens on :5173 (proxies /api to :8080)
npm test             # engine and server tests
npm run build        # typecheck, web build in dist/, server build in dist-server/
npm start            # run the production build
npm run build:demo   # browser-only demo with sample loads in dist-demo/
npm run db:generate  # new migration after a schema change
```
