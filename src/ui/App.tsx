import { useEffect, useState } from "react";
import { DEFAULT_RULES } from "../engine/synthetic";
import type { RouteCandidate, RouteLeg, Truck } from "../engine/types";
import type { Me } from "./api";
import { ago, at, clockTime, duration, miles, money, place, rpm } from "./format";
import { type BoardModel, blankTruck, MARK_LABEL, type MarkStatus } from "./model";
import { RulesPanel } from "./RulesPanel";
import { Team } from "./Team";
import { type Metric, Timeline } from "./Timeline";

type Board = BoardModel;

/** Signed-in account, when running against the server. */
export interface Account {
  me: Me;
  signOut: () => void;
}

const EQUIPMENT_LABEL = { van: "Van", reefer: "Reefer", flatbed: "Flatbed" } as const;
const planLetter = (i: number) => String.fromCharCode(65 + i);
const DEFAULT_LOCATION = { city: "Chicago", state: "IL", lat: 41.88, lon: -87.63 };

export function App({ b, account }: { b: Board; account?: Account }) {
  const [view, setView] = useState<"fleet" | "plans" | "team">(() => (window.location.hash === "#plans" ? "plans" : "fleet"));
  const [truckId, setTruckId] = useState<string | null>(null);
  // Adding a truck opens the plans view on an empty settings form.
  const [adding, setAdding] = useState(false);
  const truck = view === "plans" ? b.trucks.find((t) => t.id === truckId) ?? b.trucks[0] ?? null : null;
  const openTruck = (id: string) => { setTruckId(id); setAdding(false); setView("plans"); };
  const startAdding = () => { setAdding(true); setView("plans"); };
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = () => {
    setRefreshError(null);
    b.refresh().catch((e: unknown) => setRefreshError(e instanceof Error ? e.message : "Refresh failed"));
  };
  // The money figure shown everywhere is also what plans are ranked by.
  const metric: Metric = b.sortBy === "revenue" ? "revenue" : "revenuePerDay";

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1>Route Planner</h1>
          <nav className="tabs" aria-label="Views">
            <button aria-current={view === "fleet"} onClick={() => setView("fleet")}>Fleet</button>
            <button aria-current={view === "plans"} onClick={() => setView("plans")}>Plans</button>
            {account?.me.user.role === "owner" && (
              <button aria-current={view === "team"} onClick={() => setView("team")}>Team</button>
            )}
          </nav>
        </div>
        <div className="topbar-right">
          <div className="switch" role="radiogroup" aria-label="Show and rank by">
            <button role="radio" aria-checked={metric === "revenuePerDay"} onClick={() => b.setSortBy("revenuePerDay")}>Per day</button>
            <button role="radio" aria-checked={metric === "revenue"} onClick={() => b.setSortBy("revenue")}>Total revenue</button>
          </div>
          <span className={`feed feed-${b.stale ? "stale" : b.demo?.paused ? "paused" : "live"}`}>
            {b.lastRefreshed === null ? "Waiting for loads" : `Updated ${clockTime(b.lastRefreshed)}`}
          </span>
          <button className="link" onClick={refresh}>Refresh</button>
          {account && (
            <span className="account">
              <span className="dim">{account.me.company.name}</span>
              <button className="link" onClick={account.signOut}>Sign out</button>
            </span>
          )}
        </div>
      </header>

      {(b.stale || refreshError) && (
        <div className="banner" role="status">
          {refreshError ?? (b.lastRefreshed === null
            ? `Loads haven't loaded yet${b.feedError ? `: ${b.feedError}` : "."}`
            : <>These plans are {ago(b.lastRefreshed, b.now)} old because the load feed stopped updating
              {b.feedError ? ` (${b.feedError})` : ""}. Some loads may already be covered.</>)}{" "}
          <button className="link" onClick={() => { b.demo?.setPaused(false); refresh(); }}>Refresh now</button>
        </div>
      )}

      <main className="frame">
        {view === "team" && account ? (
          <Team me={account.me} />
        ) : view === "plans" && (truck || adding) ? (
          <PlansView b={b} truck={truck} metric={metric} adding={adding} onSelectTruck={openTruck}
            onAdd={startAdding} onDoneAdding={() => setAdding(false)} />
        ) : b.trucks.length === 0 ? (
          <div className="empty-fleet">
            <h2>Add your first truck</h2>
            <p className="dim">Tell the planner where a truck is empty and what it hauls, and it will start building plans.</p>
            <button className="btn btn-primary" onClick={startAdding}>Add truck</button>
          </div>
        ) : (
          <Timeline trucks={b.trucks} plans={b.plans} now={b.now} metric={metric} onOpen={openTruck} />
        )}
      </main>

      <footer className="foot">
        <p>
          {b.mode === "demo" ? "Sample loads until DAT access is approved. " : ""}Miles are estimated from straight-line distance, and rest breaks are a
          planning buffer, not an hours-of-service check.
        </p>
        {b.demo && (
          <span className="foot-actions">
            <button className="link" onClick={() => b.demo!.setPaused(!b.demo!.paused)}>
              {b.demo.paused ? "Resume sample feed" : "Pause sample feed"}
            </button>
            <button className="link" onClick={b.demo.resetTrucks}>Reset sample trucks</button>
          </span>
        )}
      </footer>
    </div>
  );
}

/* ---------- Plans view: trucks | plans | stops ---------- */

function PlansView({ b, truck, metric, adding, onSelectTruck, onAdd, onDoneAdding }: {
  b: Board; truck: Truck | null; metric: Metric; adding: boolean;
  onSelectTruck: (id: string) => void; onAdd: () => void; onDoneAdding: () => void;
}) {
  const routes = (truck && b.plans.get(truck.id)) || [];
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  // The last load taken out of plans by a mark, so it can be undone.
  const [lastMark, setLastMark] = useState<{ loadId: string; label: string; status: MarkStatus } | null>(null);
  useEffect(() => { setSelected(0); setEditing(false); setLastMark(null); }, [truck?.id]);
  const route = routes[Math.min(selected, routes.length - 1)];
  const unit = metric === "revenuePerDay" ? "/day" : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || adding || !routes.length) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      setSelected((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + routes.length) % routes.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, adding, routes.length]);
  const showSettings = adding || editing;
  const mark = async (loadId: string, label: string, status: MarkStatus | null) => {
    await b.setMark(loadId, status, truck?.id ?? null);
    setLastMark(status && status !== "called" ? { loadId, label, status } : null);
  };

  return (
    <div className="panes">
      <section className="pane pane-trucks" aria-label="Trucks">
        <div className="pane-head pane-head-row">
          <h2>Trucks</h2>
          <button className="link" onClick={onAdd}>Add truck</button>
        </div>
        <div className="truck-list">
          {b.trucks.map((t) => {
            const best = b.plans.get(t.id)?.[0];
            return (
              <button key={t.id} className={`row${t.id === truck?.id && !adding ? " on" : ""}`} onClick={() => onSelectTruck(t.id)}
                aria-current={t.id === truck?.id && !adding}>
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

      <section className="pane" aria-label={truck && !adding ? `Plans for ${truck.name}` : "Plans"}>
        {adding || !truck ? (
          <div className="pane-head"><h2>New truck</h2></div>
        ) : (
          <div className="pane-head pane-head-row">
            <h2>{EQUIPMENT_LABEL[truck.equipment]} · empty in {place(truck.location)}</h2>
            <button className="link" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              {editing ? "Close settings" : "Settings"}
            </button>
          </div>
        )}
        {lastMark && !adding && (
          <p className="undo small">
            {lastMark.label} marked {MARK_LABEL[lastMark.status].toLowerCase()} and taken out of plans.{" "}
            <button className="link" onClick={() => void mark(lastMark.loadId, lastMark.label, null)}>Undo</button>
          </p>
        )}
        {adding || !truck ? (
          <p className="empty">Plans appear here once the truck is saved.</p>
        ) : routes.length === 0 ? (
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
              {r.legs.some((l) => b.marks[l.load.id]) && (
                <span className="s">{r.legs.map((l) => b.marks[l.load.id]).filter(Boolean)
                  .map((m) => MARK_LABEL[m!.status]).join(" · ")}</span>
              )}
              <span className="s">
                <span className="num">{rpm(r.totals.totalRpm)}</span>/mi · {duration(r.totals.elapsedHours)}
                {r.totals.revenueIncomplete && <span className="warn"> · a rate is missing</span>}
              </span>
            </button>
          ))
        )}
      </section>

      <section className="pane pane-detail" aria-label="Plan detail">
        {showSettings ? (
          <div className="detail">
            <h2>{adding || !truck ? "Add a truck" : `Settings for ${truck.name}`}</h2>
            <RulesPanel
              key={adding ? "new" : truck!.id}
              truck={adding || !truck ? blankTruck(b.trucks, b.trucks[0]?.rules ?? DEFAULT_RULES, b.trucks[0]?.location ?? DEFAULT_LOCATION) : truck}
              isNew={adding || !truck}
              onSave={async (t) => {
                await b.saveTruck(t, adding);
                if (adding) onDoneAdding();
                setEditing(false);
              }}
              onRemove={adding || !truck ? undefined : async () => { await b.removeTruck(truck.id); setEditing(false); }}
              onCancel={() => { setEditing(false); if (adding) onDoneAdding(); }} />
          </div>
        ) : route && truck ? (
          <PlanDetail truck={truck} route={route} metric={metric} letter={planLetter(routes.indexOf(route))}
            marks={b.marks} onMark={mark} />
        ) : (
          <div className="detail dim">No plan to show.</div>
        )}
      </section>
    </div>
  );
}

type MarkFn = (loadId: string, label: string, status: MarkStatus | null) => Promise<void>;

function PlanDetail({ truck, route, metric, letter, marks, onMark }: {
  truck: Truck; route: RouteCandidate; metric: Metric; letter: string; marks: Board["marks"]; onMark: MarkFn;
}) {
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
      <ol className="stops">{route.legs.flatMap((leg) => stopsFor(leg, marks, onMark))}</ol>
      <p className="dim small">Empty in {place(t.finishPlace)} {at(t.finishAt)}. Use ↑ and ↓ to move between plans.</p>
    </div>
  );
}

const MARK_ORDER: MarkStatus[] = ["called", "booked", "rejected", "unavailable"];

function MarkButtons({ loadId, label, current, onMark }: {
  loadId: string; label: string; current: MarkStatus | undefined; onMark: MarkFn;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = async (status: MarkStatus | null) => {
    setBusy(true);
    setError(null);
    try { await onMark(loadId, label, status); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save"); }
    finally { setBusy(false); }
  };
  return (
    <div className="marks" role="group" aria-label={`Mark load ${label}`}>
      {MARK_ORDER.map((s) => (
        <button key={s} className="chip" aria-pressed={current === s} disabled={busy}
          onClick={() => void press(current === s ? null : s)}>{MARK_LABEL[s]}</button>
      ))}
      {error && <span className="warn small">{error}</span>}
    </div>
  );
}

function stopsFor(leg: RouteLeg, marks: Board["marks"], onMark: MarkFn) {
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
        <MarkButtons loadId={l.id} label={`${l.origin.city} → ${l.destination.city}`} current={marks[l.id]?.status} onMark={onMark} />
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
