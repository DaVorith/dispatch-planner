import { useEffect, useState } from "react";
import type { RouteCandidate, RouteLeg, Truck } from "../engine/types";
import { ago, at, clockTime, duration, miles, money, place, rpm } from "./format";
import { RulesPanel } from "./RulesPanel";
import { type Metric, Timeline } from "./Timeline";
import { useBoard } from "./useBoard";

type Board = ReturnType<typeof useBoard>;

const EQUIPMENT_LABEL = { van: "Van", reefer: "Reefer", flatbed: "Flatbed" } as const;
const planLetter = (i: number) => String.fromCharCode(65 + i);

export function App() {
  const b = useBoard();
  // null = fleet week view; otherwise the truck open in the plans view.
  const [truckId, setTruckId] = useState<string | null>(() =>
    window.location.hash === "#plans" ? b.trucks[0]?.id ?? null : null);
  const truck = truckId ? b.trucks.find((t) => t.id === truckId) ?? null : null;
  // The money figure shown everywhere is also what plans are ranked by.
  const metric: Metric = b.sortBy === "revenue" ? "revenue" : "revenuePerDay";

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1>Route Planner</h1>
          <nav className="tabs" aria-label="Views">
            <button aria-current={!truck} onClick={() => setTruckId(null)}>Fleet</button>
            <button aria-current={!!truck} onClick={() => setTruckId(truckId ?? b.trucks[0]?.id ?? null)}>Plans</button>
          </nav>
        </div>
        <div className="topbar-right">
          <div className="switch" role="radiogroup" aria-label="Show and rank by">
            <button role="radio" aria-checked={metric === "revenuePerDay"} onClick={() => b.setSortBy("revenuePerDay")}>Per day</button>
            <button role="radio" aria-checked={metric === "revenue"} onClick={() => b.setSortBy("revenue")}>Total revenue</button>
          </div>
          <span className={`feed feed-${b.stale ? "stale" : b.feed.paused ? "paused" : "live"}`}>
            Updated {clockTime(b.feed.lastRefreshed)}
          </span>
          <button className="link" onClick={b.refresh}>Refresh</button>
        </div>
      </header>

      {b.stale && (
        <div className="banner" role="status">
          These plans are {ago(b.feed.lastRefreshed, b.now)} old because the load feed stopped updating. Some loads may
          already be covered.{" "}
          <button className="link" onClick={() => { b.setPaused(false); b.refresh(); }}>Refresh now</button>
        </div>
      )}

      <main className="frame">
        {truck ? (
          <PlansView b={b} truck={truck} metric={metric} onSelectTruck={setTruckId} />
        ) : (
          <Timeline trucks={b.trucks} plans={b.plans} now={b.now} metric={metric} onOpen={setTruckId} />
        )}
      </main>

      <footer className="foot">
        <p>
          Sample loads until DAT access is approved. Miles are estimated from straight-line distance, and rest breaks are a
          planning buffer, not an hours-of-service check.
        </p>
        <span className="foot-actions">
          <button className="link" onClick={() => b.setPaused(!b.feed.paused)}>
            {b.feed.paused ? "Resume sample feed" : "Pause sample feed"}
          </button>
          <button className="link" onClick={b.resetTrucks}>Reset sample trucks</button>
        </span>
      </footer>
    </div>
  );
}

/* ---------- Plans view: trucks | plans | stops ---------- */

function PlansView({ b, truck, metric, onSelectTruck }: {
  b: Board; truck: Truck; metric: Metric; onSelectTruck: (id: string) => void;
}) {
  const routes = b.plans.get(truck.id) ?? [];
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setSelected(0); setEditing(false); }, [truck.id]);
  const route = routes[Math.min(selected, routes.length - 1)];
  const unit = metric === "revenuePerDay" ? "/day" : "";

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
                  <span className="t"><span className={`eq eq-${t.equipment}`} aria-hidden="true" />{t.name}</span>
                  <span className="num">{best ? money(best.totals[metric]) : "—"}</span>
                </span>
                <span className="s">{t.location.city}, {t.location.state}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="pane" aria-label={`Plans for ${truck.name}`}>
        <div className="pane-head pane-head-row">
          <h2>{EQUIPMENT_LABEL[truck.equipment]} · empty in {place(truck.location)}</h2>
          <button className="link" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? "Close settings" : "Settings"}
          </button>
        </div>
        {routes.length === 0 ? (
          <p className="empty">No loads fit this truck's equipment, deadhead limit and timing rules right now. Try a larger
            deadhead limit or a lower minimum rate in Settings.</p>
        ) : (
          routes.map((r, i) => (
            <button key={r.id} className={`row${r === route && !editing ? " on" : ""}`}
              onClick={() => { setSelected(i); setEditing(false); }}>
              <span className="row-top">
                <span className="t">Plan {planLetter(i)}</span>
                <span className="num strong">{money(r.totals[metric])}{unit}</span>
              </span>
              <span className="s"><LaneChain truck={truck} route={r} short /></span>
              <span className="s">
                <span className="num">{rpm(r.totals.totalRpm)}</span>/mi · {duration(r.totals.elapsedHours)}
                {r.totals.revenueIncomplete && <span className="warn"> · a rate is missing</span>}
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
          <PlanDetail truck={truck} route={route} metric={metric} letter={planLetter(routes.indexOf(route))} />
        ) : (
          <div className="detail dim">No plan to show.</div>
        )}
      </section>
    </div>
  );
}

function PlanDetail({ truck, route, metric, letter }: { truck: Truck; route: RouteCandidate; metric: Metric; letter: string }) {
  const t = route.totals;
  const flags = route.flags.filter((f) => !f.startsWith("Ends"));
  return (
    <div className="detail">
      <div className="detail-head">
        <h2>Plan {letter} · {truck.name}</h2>
        <p className="big num">
          {money(t[metric])}{metric === "revenuePerDay" ? <small>/day</small> : t.revenueIncomplete ? "+" : ""}
        </p>
      </div>
      <dl className="kv">
        <KV label="Rate per mile" value={`${rpm(t.totalRpm)}`} note="all miles" />
        <KV label="Loaded miles" value={miles(t.loadedMiles)} />
        <KV label="Empty miles" value={miles(t.deadheadMiles)} />
        <KV label="Time" value={duration(t.elapsedHours)} />
      </dl>
      {flags.length > 0 && <p className="warn small">{flags.join(" · ")}</p>}
      <ol className="stops">{route.legs.flatMap((leg) => stopsFor(leg))}</ol>
      <p className="dim small">Empty in {place(t.finishPlace)} {at(t.finishAt)}. Use ↑ and ↓ to move between plans.</p>
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
        <div className="what"><span>Drive empty {miles(leg.deadheadMiles)}</span></div>
      </li>,
    );
  }
  items.push(
    <li key={`${l.id}-pu`} className="stop">
      <span className="dot" aria-hidden="true" />
      <div>
        <div className="what">
          <strong>{place(l.origin)}</strong>
          <span className="meta">Pick up {at(leg.pickupStart)}</span>
        </div>
        <div className="legfig">
          <span className="num">{l.rate === null ? <span className="warn">No rate posted</span> : money(l.rate)}</span>
          {" · "}<span className="num">{miles(leg.loadedMiles)}</span>{leg.loadedMilesProvenance === "estimated" ? " (est.)" : ""}
          {" · "}<span className="num">{rpm(leg.loadedRpm)}</span>/mi
        </div>
        <div className="meta">
          {l.broker} · <span className="selectable">{l.brokerPhone}</span> · Ref <span className="selectable">{l.sourceId}</span>
        </div>
        {leg.notes.length > 0 && <div className="meta warn">{leg.notes.join(" · ")}</div>}
      </div>
    </li>,
    <li key={`${l.id}-del`} className="stop stop-del">
      <span className="dot" aria-hidden="true" />
      <div className="what">
        <strong>{place(l.destination)}</strong>
        <span className="meta">Deliver {at(leg.deliveryStart)}{l.deliveryLatest !== null ? `, appt by ${at(l.deliveryLatest)}` : ""}</span>
      </div>
    </li>,
  );
  return items;
}

function KV({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div><dt>{label}</dt><dd className="num">{value}{note && <small> {note}</small>}</dd></div>;
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
        <span key={i}>{i > 0 && <i aria-hidden="true">→</i>}{short ? p.city : place(p)}</span>
      ))}
    </span>
  );
}
