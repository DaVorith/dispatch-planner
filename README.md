# Dispatch Route Planner

Builds multi-load route plans for each truck from load-board data and shows them side by side so a dispatcher can pick one, call the broker and book. Booking stays manual.

## Status

Prototype. Runs entirely in the browser on a synthetic load board (DAT integration waits on written API approval). Distances are straight-line × 1.18 until a routing provider is added. Rest breaks are a planning buffer, not an HOS check.

## Layout

- `src/engine/` – deterministic planning: data model (`types.ts`), feasibility and route search (`planner.ts`), synthetic board (`synthetic.ts`), timezone helpers (`clock.ts`). No UI code.
- `src/ui/` – React dispatcher screen.

## Commands

```
npm install
npm run dev       # local dev server
npm test          # engine tests
npm run build     # typecheck + single-file build in dist/
```
