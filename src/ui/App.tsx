import { useEffect, useState } from "react";
import type { RouteCandidate, RouteLeg, SortKey, Truck } from "../engine/types";
import { ago, at, clockTime, duration, miles, money, place, rpm } from "./format";
import { RulesPanel } from "./RulesPanel";
import { REFRESH_EVERY_MS, useBoard } from "./useBoard";

type Board = ReturnType<typeof useBoard>;

const SORTS: { key: SortKey; label: string }[] = [
  { key: "revenuePerDay", label: "$/day" },
  { key: "totalRpm", label: "RPM" },
  { key: "revenue", label: "Revenue" },
  { key: "leastDeadhead", label: "Deadhead" },
];
const EQUIPMENT_LABEL = { van: "Van", reefer: "Reefer", flatbed: "Flatbed" } as const;
const planLetter = (i: number) => String.fromCharCode(65 + i);
const isAvailable = (t: Truck, now: number) => t.availableAt <= now;

export function App() {
  const b = useBoard();
  // null = fleet board; otherwise the truck open in the plans view.
  const [truckId, setTruckId] = useState<string | null>(() =>
    window.location.hash === "#plans" ? b.trucks[0]?.id ?? null : null);
  const truck = truckId ? b.trucks.find((t) => t.id === truckId) ?? null : null;

  return (
    <div className="app">
      <TopBar b={b} view={truck ? "plans" : "fleet"} onFleet={() => setTruckId(null)}
        onPlans={() => setTruckId(truckId ?? b.trucks[0]?.id ?? null)} />
      {b.stale && (
        <div className="banner" role="status">
          Plans are {ago(b.feed.lastRefreshed, b.now)} old because the load feed stopped updating. Some loads may
          already be covered.{" "}
          <button className="link" onClick={() => { b.setPaused(false); b.refresh(); }}>Refresh now</button>
        </div>
      )}
      <main className="frame">
        {truck ? <PlansView b={b} truck={truck} onSelectTruck={setTruckId} /> : <FleetBoard b={b} onOpen={setTruckId} />}
      </main>
      <footer className="foot">
        <p>
          Sample loads until DAT access is approved. Miles are straight-line distance × 1.18 until a routing service is
          connected. Rest breaks are a planning buffer, not an hours-of-service check.
        </p>
        <button className="link" onClick={b.resetTrucks}>Reset sample trucks</button>
      </footer>
    </div>
  );
}

function TopBar({ b, view, onFleet, onPlans }: {
  b: Board; view: "fleet" | "plans"; onFleet: () => void; onPlans: () => void;
}) {
  const state = b.stale ? "stale" : b.feed.paused ? "paused" : "live";
  const next = Math.max(0, Math.ceil((b.feed.lastRefreshed + REFRESH_EVERY_MS - b.now) / 1000));
  return (
    <header className="topbar">
      <div className="topbar-left">
        <h1>Route Planner</h1>
        <nav className="tabs" aria-label="Views">
          <button aria-current={view === "fleet"} onClick={onFleet}>Fleet</button>
          <button aria-current={view === "plans"} onClick={onPlans}>Plans</button>
        </nav>
      </div>
      <div className="topbar-right">
        <span className={`feed feed-${state}`}>
          {state === "live" ? "Sample feed live" : state === "paused" ? "Feed paused" : "Feed stale"}
        </span>
        <span className="dim num" title={`${b.board.length.toLocaleString()} loads on the board`}>
          {clockTime(b.feed.lastRefreshed)}
          {!b.feed.paused && ` · next ${next}s`}
        </span>
        <button className="quiet" onClick={b.refresh}>Refresh</button>
        <button className="quiet" onClick={() => b.setPaused(!b.feed.paused)}
          title="Stop the feed to see how out-of-date plans are flagged">
          {b.feed.paused ? "Resume" : "Pause"}
        </button>
        <span className="sort">
          <span className="dim">Sort</span>
          <span className="seg" role="radiogroup" aria-label="Sort plans by">
            {SORTS.map((s) => (
              <button key={s.key} role="radio" aria-checked={b.sortBy === s.key} onClick={() => b.setSortBy(s.key)}>
                {s.label}
              </button>
            ))}
          </span>
        </span>
      </div>
    </header>
  );
}

/* ---------- Fleet board: one row per truck ---------- */

function FleetBoard({ b, onOpen }: { b: Board; onOpen: (id: string) => void }) {
  return (
    <div className="board-scroll">
      <table className="board">
        <thead>
          <tr>
            <th>Truck</th><th>Empty at</th><th>Best plan</th>
            <th className="r">$/day</th><th className="r">Revenue</th><th className="r">RPM all</th>
            <th className="r">Deadhead</th><th className="r">Loaded mi</th><th className="r">Time</th><th className="r">Plans</th>
          </tr>
        </thead>
        <tbody>
          {b.trucks.map((t) => {
            const plans = b.plans.get(t.id) ?? [];
            const best = plans[0];
            return (
              <tr key={t.id} tabIndex={0} onClick={() => onOpen(t.id)}
                onKeyDown={(e) => { if (e.key === "Enter") onOpen(t.id); }}>
                <td>
                  <span className="tname"><EqDot t={t} />{t.name}</span>
                  <div className="sub">{EQUIPMENT_LABEL[t.equipment]} · {t.driver}</div>
                </td>
                <td>
                  {place(t.location)}
                  <div className="sub">{isAvailable(t, b.now) ? "now" : at(t.availableAt)}</div>
                </td>
                {best ? (
                  <>
                    <td className="lanecell">
                      <LaneChain truck={t} route={best} short />
                      {warnings(best).length > 0 && <div className="sub warn">{warnings(best).join(" · ")}</div>}
                    </td>
                    <td className="r num strong">{money(best.totals.revenuePerDay)}</td>
                    <td className="r num">{money(best.totals.revenue)}{best.totals.revenueIncomplete ? "+" : ""}</td>
                    <td className="r num">{rpm(best.totals.totalRpm)}</td>
                    <td className="r num">{Math.round(best.totals.deadheadMiles).toLocaleString()}</td>
                    <td className="r num">{Math.round(best.totals.loadedMiles).toLocaleString()}</td>
                    <td className="r num">{duration(best.totals.elapsedHours)}</td>
                    <td className="r num dim">{plans.length}</td>
                  </>
                ) : (
                  <td className="lanecell dim" colSpan={8}>No plan fits this truck's rules right now</td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Plans view: trucks | plans | stops ---------- */

function PlansView({ b, truck, onSelectTruck }: { b: Board; truck: Truck; onSelectTruck: (id: string) => void }) {
  const routes = b.plans.get(truck.id) ?? [];
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setSelected(0); setEditing(false); }, [truck.id]);
  const route = routes[Math.min(selected, routes.length - 1)];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || !routes.length) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      setSelected((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + routes.length) % routes.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, routes.length]);

  return (
    <div className="panes">
      <section className="pane pane-trucks" aria-label="Trucks">
        <h2 className="pane-head">Trucks</h2>
        <div className="truck-list">
          {b.trucks.map((t) => {
            const best = b.plans.get(t.id)?.[0];
            return (
              <button key={t.id} className={`row${t.id === truck.id ? " on" : ""}`} onClick={() => onSelectTruck(t.id)}
                aria-current={t.id === truck.id}>
                <span className="row-top">
                  <span className="t"><EqDot t={t} />{t.name}</span>
                  <span className="num">{best ? money(best.totals.revenuePerDay) : "—"}</span>
                </span>
                <span className="s">{place(t.location)} · {isAvailable(t, b.now) ? "now" : at(t.availableAt)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pane" aria-label={`Plans for ${truck.name}`}>
        <div className="pane-head pane-head-row">
          <h2>{truck.name} · empty in {place(truck.location)}</h2>
          <button className="link" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? "Close settings" : "Settings"}
          </button>
        </div>
        <RuleLine truck={truck} />
        {routes.length === 0 ? (
          <p className="empty">No loads on the board fit this truck's equipment, deadhead limit and timing rules. Try a
            larger deadhead limit or a lower minimum rate in Settings.</p>
        ) : (
          routes.map((r, i) => (
            <button key={r.id} className={`row${r === route && !editing ? " on" : ""}`}
              onClick={() => { setSelected(i); setEditing(false); }}>
              <span className="row-top">
                <span className="t">Plan {planLetter(i)}</span>
                <span className="num strong">{money(r.totals.revenuePerDay)}/day</span>
              </span>
              <span className="s"><LaneChain truck={truck} route={r} short /></span>
              <span className="s num">
                {rpm(r.totals.totalRpm)} RPM · {Math.round(r.totals.deadheadMiles)} mi DH · {duration(r.totals.elapsedHours)}
                {r.totals.revenueIncomplete && <span className="warn"> · rate missing</span>}
              </span>
            </button>
          ))
        )}
      </section>

      <section className="pane pane-detail" aria-label="Plan detail">
        {editing ? (
          <div className="detail">
            <h2>Settings for {truck.name}</h2>
            <RulesPanel truck={truck} onSave={(t) => { b.updateTruck(t); setEditing(false); }}
              onCancel={() => setEditing(false)} />
          </div>
        ) : route ? (
          <PlanDetail truck={truck} route={route} letter={planLetter(routes.indexOf(route))} />
        ) : (
          <div className="detail dim">No plan to show.</div>
        )}
      </section>
    </div>
  );
}

function PlanDetail({ truck, route, letter }: { truck: Truck; route: RouteCandidate; letter: string }) {
  const t = route.totals;
  return (
    <div className="detail">
      <div>
        <h2>Plan {letter} for {truck.name}</h2>
        <div className="dim"><LaneChain truck={truck} route={route} /></div>
      </div>
      <dl className="kv">
        <KV label="Revenue/day" value={money(t.revenuePerDay)} />
        <KV label="Revenue" value={`${money(t.revenue)}${t.revenueIncomplete ? "+" : ""}`} />
        <KV label="RPM all mi" value={rpm(t.totalRpm)} />
        <KV label="RPM loaded" value={rpm(t.loadedRpm)} />
        <KV label="Loaded" value={miles(t.loadedMiles)} />
        <KV label="Deadhead" value={miles(t.deadheadMiles)} />
        <KV label="Total" value={miles(t.totalMiles)} />
        <KV label="Time" value={duration(t.elapsedHours)} />
      </dl>
      {route.flags.length > 0 && (
        <ul className="flags">
          {route.flags.map((f) => <li key={f} className={f.startsWith("Ends") ? "dim" : "warn"}>{f}</li>)}
        </ul>
      )}
      <ol className="stops">
        {route.legs.flatMap((leg) => stopsFor(leg))}
      </ol>
      <p className="dim">Empty in {place(t.finishPlace)} {at(t.finishAt)}. Use ↑ and ↓ to move between plans.</p>
    </div>
  );
}

function stopsFor(leg: RouteLeg) {
  const l = leg.load;
  const items = [];
  if (leg.deadheadMiles > 0) {
    items.push(
      <li key={`${l.id}-dh`} className="stop stop-dh">
        <span className="dot" aria-hidden="true" />
        <div className="what"><span>Drive empty {miles(leg.deadheadMiles)}</span><span className="meta">leave {at(leg.departForPickup)}</span></div>
      </li>,
    );
  }
  items.push(
    <li key={`${l.id}-pu`} className="stop">
      <span className="dot" aria-hidden="true" />
      <div>
        <div className="what">
          <strong>{place(l.origin)}</strong>
          <span className="meta">Pick up {at(leg.pickupStart)} · window ends {at(l.pickupLatest)}</span>
        </div>
        <div className="legfig num">
          {l.rate === null ? <span className="warn">No rate posted</span> : money(l.rate)} · {miles(leg.loadedMiles)}
          {leg.loadedMilesProvenance === "estimated" ? " (est.)" : ""} · {rpm(leg.loadedRpm)}/mi ·{" "}
          {l.weightLbs === null ? "weight —" : `${(l.weightLbs / 1000).toFixed(1)}k lb`}
        </div>
        <div className="meta">
          {l.broker} · <span className="selectable">{l.brokerPhone}</span> · {l.commodity ?? "commodity not posted"} · Ref{" "}
          <span className="selectable">{l.sourceId}</span>
        </div>
        {leg.notes.length > 0 && <div className="meta warn">{leg.notes.join(" · ")}</div>}
      </div>
    </li>,
    <li key={`${l.id}-del`} className="stop stop-del">
      <span className="dot" aria-hidden="true" />
      <div className="what">
        <strong>{place(l.destination)}</strong>
        <span className="meta">
          Deliver {at(leg.deliveryStart)} · {l.deliveryLatest !== null ? `appt by ${at(l.deliveryLatest)}` : "no appointment"}
        </span>
      </div>
    </li>,
  );
  return items;
}

/* ---------- small pieces ---------- */

function EqDot({ t }: { t: Truck }) {
  return <span className={`eq eq-${t.equipment}`} title={EQUIPMENT_LABEL[t.equipment]} aria-hidden="true" />;
}

function KV({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd className="num">{value}</dd></div>;
}

function LaneChain({ truck, route, short = false }: { truck: Truck; route: RouteCandidate; short?: boolean }) {
  const stops = [truck.location];
  for (const leg of route.legs) {
    if (place(stops[stops.length - 1]!) !== place(leg.load.origin)) stops.push(leg.load.origin);
    stops.push(leg.load.destination);
  }
  return (
    <span className="lane">
      {stops.map((p, i) => (
        <span key={i}>{i > 0 && <i aria-hidden="true">›</i>}{short ? p.city : place(p)}</span>
      ))}
    </span>
  );
}

function RuleLine({ truck }: { truck: Truck }) {
  const r = truck.rules;
  const parts = [
    `${EQUIPMENT_LABEL[truck.equipment]}`,
    `up to ${r.maxLoadsPerRoute} loads`,
    `≤ ${r.maxDeadheadMiles} mi DH`,
    r.minLoadedRpm > 0 ? `≥ $${r.minLoadedRpm.toFixed(2)}/mi` : null,
    r.avoidStates.length ? `avoid ${r.avoidStates.join(", ")}` : null,
    r.homeBase && r.maxMilesFromHomeAtEnd !== null ? `end ≤ ${r.maxMilesFromHomeAtEnd} mi from ${r.homeBase.city}` : null,
    r.excludeLoadsWithoutRate ? "rated loads only" : null,
  ].filter(Boolean);
  return <p className="ruleline">{parts.join(" · ")}</p>;
}

/** Warnings worth showing on the board row; the "Ends N mi from home" note is informational. */
function warnings(r: RouteCandidate): string[] {
  return r.flags.filter((f) => !f.startsWith("Ends"));
}
