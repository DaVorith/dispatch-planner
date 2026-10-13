import { useEffect, useMemo, useState } from "react";
import type { RouteCandidate, RouteLeg, SortKey, Truck } from "../engine/types";
import { ago, at, clockTime, duration, hourLabel, miles, money, place, rpm } from "./format";
import { RulesPanel } from "./RulesPanel";
import { REFRESH_EVERY_MS, useBoard } from "./useBoard";

const SORT_LABELS: Record<SortKey, string> = {
  revenuePerDay: "Revenue per day",
  totalRpm: "RPM (all miles)",
  revenue: "Total revenue",
  leastDeadhead: "Least deadhead",
};

const EQUIPMENT_LABEL = { van: "Dry van", reefer: "Reefer", flatbed: "Flatbed" } as const;

export function App() {
  const b = useBoard();
  const [selectedId, setSelectedId] = useState(() => b.trucks[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const truck = b.trucks.find((t) => t.id === selectedId) ?? b.trucks[0];
  const routes = truck ? b.plans.get(truck.id) ?? [] : [];

  useEffect(() => setEditing(false), [selectedId]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Route Planner</h1>
            <p className="brand-sub">Multi-load plans for every truck, rebuilt as the board changes</p>
          </div>
        </div>
        <FeedStatus b={b} />
      </header>

      {b.stale && (
        <div className="banner banner-warn" role="status">
          Plans are {ago(b.feed.lastRefreshed, b.now)} old. The load feed isn't updating, so some of these loads may
          already be covered. <button className="link" onClick={() => { b.setPaused(false); b.refresh(); }}>Refresh now</button>
        </div>
      )}

      <div className="layout">
        <nav className="fleet" aria-label="Trucks">
          <div className="fleet-head">
            <span className="eyebrow">Fleet · {b.trucks.length} trucks</span>
          </div>
          <label className="fleet-select">
            <span className="sr-only">Truck</span>
            <select id="truck-select" value={truck?.id} onChange={(e) => setSelectedId(e.target.value)}>
              {b.trucks.map((t) => (
                <option key={t.id} value={t.id}>{t.name} · {place(t.location)}</option>
              ))}
            </select>
          </label>
          <ul className="fleet-list">
            {b.trucks.map((t) => (
              <TruckRow key={t.id} truck={t} best={b.plans.get(t.id)?.[0]} active={t.id === truck?.id}
                now={b.now} onSelect={() => setSelectedId(t.id)} />
            ))}
          </ul>
        </nav>

        {truck && (
          <main className="workspace">
            <section className="truck-head">
              <div className="truck-title">
                <h2>{truck.name}</h2>
                <span className={`chip chip-${truck.equipment}`}>{EQUIPMENT_LABEL[truck.equipment]}</span>
              </div>
              <p className="truck-meta">
                {truck.driver} · Empty in <strong>{place(truck.location)}</strong> ·{" "}
                {truck.availableAt <= b.now ? "Available now" : `Available ${at(truck.availableAt)}`}
              </p>
              <RuleSummary truck={truck} />
              <div className="truck-actions">
                <button className="btn" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                  {editing ? "Close settings" : "Truck settings"}
                </button>
                <label className="sort">
                  <span>Sort plans by</span>
                  <select id="sort-by" value={b.sortBy} onChange={(e) => b.setSortBy(e.target.value as SortKey)}>
                    {Object.entries(SORT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
              </div>
            </section>

            {editing && (
              <RulesPanel truck={truck} onSave={(t) => { b.updateTruck(t); setEditing(false); }}
                onCancel={() => setEditing(false)} />
            )}

            <section aria-label="Route plans" className="plans">
              {routes.length === 0 ? (
                <div className="empty">
                  <h3>No workable plans right now</h3>
                  <p>No loads on the board fit this truck's equipment, deadhead limit and timing rules. Try a larger
                    deadhead limit or a lower minimum rate in Truck settings.</p>
                </div>
              ) : (
                routes.map((r, i) => <RouteCard key={r.id} route={r} rank={i + 1} truck={truck} sortBy={b.sortBy} />)
              )}
            </section>
          </main>
        )}
      </div>

      <footer className="foot">
        <p>
          Sample data: loads are generated to look like a real board (including missing rates and miles) until DAT
          access is approved. Miles are straight-line distance × 1.18 until a routing service is connected. Rest breaks
          are a planning buffer, not an hours-of-service check.
        </p>
        <button className="link" onClick={b.resetTrucks}>Reset sample trucks</button>
      </footer>
    </div>
  );
}

function FeedStatus({ b }: { b: ReturnType<typeof useBoard> }) {
  const next = b.feed.lastRefreshed + REFRESH_EVERY_MS;
  const state = b.stale ? "stale" : b.feed.paused ? "paused" : "live";
  return (
    <div className="feed">
      <div className={`feed-pill feed-${state}`}>
        <span className="dot" aria-hidden="true" />
        {state === "live" ? "Sample feed live" : state === "paused" ? "Feed paused" : "Feed stale"}
      </div>
      <div className="feed-detail">
        <span>Updated {clockTime(b.feed.lastRefreshed)} ({ago(b.feed.lastRefreshed, b.now)})</span>
        <span>
          {b.board.length.toLocaleString()} loads
          {b.feed.refreshCount > 0 && ` · +${b.feed.added} new, −${b.feed.removed} gone`}
          {!b.feed.paused && ` · next in ${Math.max(0, Math.ceil((next - b.now) / 1000))}s`}
        </span>
      </div>
      <div className="feed-actions">
        <button className="btn btn-quiet" onClick={b.refresh}>Refresh now</button>
        <button className="btn btn-quiet" onClick={() => b.setPaused(!b.feed.paused)}
          title="Stop the feed to see how stale data is flagged">
          {b.feed.paused ? "Resume feed" : "Pause feed"}
        </button>
      </div>
    </div>
  );
}

function TruckRow({ truck, best, active, now, onSelect }: {
  truck: Truck; best: RouteCandidate | undefined; active: boolean; now: number; onSelect: () => void;
}) {
  return (
    <li>
      <button className={`truck-row${active ? " is-active" : ""}`} onClick={onSelect} aria-current={active}>
        <span className="truck-row-top">
          <span className="truck-row-name">{truck.name}</span>
          <span className={`chip chip-sm chip-${truck.equipment}`}>{EQUIPMENT_LABEL[truck.equipment]}</span>
        </span>
        <span className="truck-row-loc">
          {place(truck.location)} · {truck.availableAt <= now ? "now" : at(truck.availableAt)}
        </span>
        <span className="truck-row-best">
          {best ? (
            <>
              <span className="num">{money(best.totals.revenuePerDay)}</span>/day best ·{" "}
              {best.legs.length} load{best.legs.length > 1 ? "s" : ""}
            </>
          ) : (
            <span className="muted">No plans fit</span>
          )}
        </span>
      </button>
    </li>
  );
}

function RuleSummary({ truck }: { truck: Truck }) {
  const r = truck.rules;
  const items = [
    `Up to ${r.maxLoadsPerRoute} loads`,
    `≤ ${r.maxDeadheadMiles} mi deadhead`,
    r.minLoadedRpm > 0 ? `≥ $${r.minLoadedRpm.toFixed(2)}/mi loaded` : "Any rate",
    `${r.dwellHours}h load/unload`,
    r.noSameDayPickupAfterHour !== null ? `No same-day reload after ${hourLabel(r.noSameDayPickupAfterHour)}` : null,
    r.avoidStates.length ? `Avoid ${r.avoidStates.join(", ")}` : null,
    r.homeBase && r.maxMilesFromHomeAtEnd !== null ? `End within ${r.maxMilesFromHomeAtEnd} mi of ${place(r.homeBase)}` : null,
    r.excludeLoadsWithoutRate ? "Rated loads only" : null,
  ].filter(Boolean);
  return (
    <ul className="rules">
      {items.map((x) => <li key={x}>{x}</li>)}
    </ul>
  );
}

function RouteCard({ route, rank, truck, sortBy }: { route: RouteCandidate; rank: number; truck: Truck; sortBy: SortKey }) {
  const [open, setOpen] = useState(rank === 1);
  const t = route.totals;
  const stops = useMemo(() => [truck.location, ...route.legs.flatMap((l) => [l.load.origin, l.load.destination])]
    .filter((p, i, arr) => i === 0 || place(p) !== place(arr[i - 1]!)), [route, truck]);
  const highlight = (k: SortKey) => (k === sortBy ? " is-sorted" : "");

  return (
    <article className={`route${open ? " is-open" : ""}`}>
      <button className="route-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="route-rank">Plan {String.fromCharCode(64 + rank)}</span>
        <span className="route-path">
          {stops.map((p, i) => (
            <span key={i} className="stop">
              {i > 0 && <span className="arrow" aria-hidden="true">›</span>}
              {p.city}, {p.state}
            </span>
          ))}
        </span>
        <span className="route-toggle" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      <dl className="metrics">
        <Metric label="Revenue / day" value={money(t.revenuePerDay)} cls={highlight("revenuePerDay")} />
        <Metric label="Revenue" value={`${money(t.revenue)}${t.revenueIncomplete ? "+" : ""}`} cls={highlight("revenue")} />
        <Metric label="RPM, all miles" value={rpm(t.totalRpm)} cls={highlight("totalRpm")} />
        <Metric label="RPM, loaded" value={rpm(t.loadedRpm)} />
        <Metric label="Loaded" value={miles(t.loadedMiles)} />
        <Metric label="Deadhead" value={miles(t.deadheadMiles)} cls={highlight("leastDeadhead")} />
        <Metric label="Total" value={miles(t.totalMiles)} />
        <Metric label="Time" value={duration(t.elapsedHours)} />
      </dl>

      {route.flags.length > 0 && (
        <ul className="flags">
          {route.flags.map((f) => <li key={f} className={f.startsWith("Ends") ? "flag-info" : "flag-warn"}>{f}</li>)}
        </ul>
      )}

      {open && (
        <ol className="legs">
          {route.legs.map((leg, i) => <LegRow key={leg.load.id} leg={leg} n={i + 1} />)}
          <li className="leg-end">Empty in {place(t.finishPlace)} at {at(t.finishAt)}</li>
        </ol>
      )}
    </article>
  );
}

function Metric({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className={`metric${cls}`}>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function LegRow({ leg, n }: { leg: RouteLeg; n: number }) {
  const l = leg.load;
  return (
    <li className="leg">
      <div className="leg-n" aria-hidden="true">{n}</div>
      <div className="leg-body">
        {leg.deadheadMiles > 0 && (
          <p className="leg-deadhead">Deadhead {miles(leg.deadheadMiles)}, leave {at(leg.departForPickup)}</p>
        )}
        <div className="leg-lane">
          <div>
            <span className="eyebrow">Pick up</span>
            <strong>{place(l.origin)}</strong>
            <span className="leg-time">{at(leg.pickupStart)}</span>
            <span className="leg-window">Window {at(l.pickupEarliest)} – {at(l.pickupLatest)}</span>
          </div>
          <div>
            <span className="eyebrow">Deliver</span>
            <strong>{place(l.destination)}</strong>
            <span className="leg-time">{at(leg.deliveryStart)}</span>
            <span className="leg-window">
              {l.deliveryLatest !== null ? `Appt by ${at(l.deliveryLatest)}` : "No appointment posted"}
            </span>
          </div>
        </div>
        <div className="leg-figs">
          <span><b className="num">{l.rate === null ? "No rate" : money(l.rate)}</b> rate</span>
          <span><b className="num">{miles(leg.loadedMiles)}</b> loaded{leg.loadedMilesProvenance === "estimated" ? " (est.)" : ""}</span>
          <span><b className="num">{rpm(leg.loadedRpm)}</b> loaded RPM</span>
          <span><b className="num">{l.weightLbs === null ? "—" : `${(l.weightLbs / 1000).toFixed(1)}k lb`}</b> weight</span>
        </div>
        <p className="leg-broker">
          {l.broker} · <span className="num selectable">{l.brokerPhone}</span> · {l.commodity ?? "Commodity not posted"} ·
          Ref <span className="num selectable">{l.sourceId}</span>
        </p>
        {leg.notes.length > 0 && <p className="leg-notes">{leg.notes.join(" · ")}</p>}
      </div>
    </li>
  );
}
