// Fleet week view: one row per truck across the next seven days, its best
// plan drawn as load bars so a dispatcher sees at a glance where every truck
// is, when it's loaded, and when it's sitting empty.

import { DEFAULT_TZ, localParts, zonedTime } from "../engine/clock";
import type { RouteCandidate, Truck } from "../engine/types";
import { at, money, place, rpm, shortWhen } from "./format";

export type Metric = "revenuePerDay" | "revenue";

const DAYS = 7;
const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, weekday: "short", month: "numeric", day: "numeric" });

function startOfToday(now: number): number {
  const p = localParts(now, DEFAULT_TZ);
  return zonedTime(p.year, p.month, p.day, 0, DEFAULT_TZ);
}

/** Local midnights for the visible days (handles DST by asking the clock, not adding 24h). */
function dayStarts(now: number): number[] {
  const p = localParts(now, DEFAULT_TZ);
  return Array.from({ length: DAYS + 1 }, (_, i) => {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    return zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, DEFAULT_TZ);
  });
}

export function Timeline({ trucks, plans, now, metric, onOpen }: {
  trucks: Truck[];
  plans: Map<string, RouteCandidate[]>;
  now: number;
  metric: Metric;
  onOpen: (truckId: string) => void;
}) {
  // Start a couple of hours back so "now" sits near the left edge whatever the time of day.
  const start = now - 2 * 3_600_000;
  const end = start + DAYS * 24 * 3_600_000;
  const days = [startOfToday(now), ...dayStarts(now).slice(1)];
  const pct = (ms: number) => ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * 100;
  const span = (a: number, b: number) => ({ left: `${pct(a)}%`, width: `${Math.max(0.4, pct(b) - pct(a))}%` });

  return (
    <div className="tl-scroll">
      <div className="tl" role="table" aria-label="Fleet week">
        <div className="tl-head" role="row">
          <div className="tl-who" role="columnheader">Truck</div>
          <div className="tl-days" role="columnheader">
            {days.slice(0, DAYS + 1).filter((d) => d < end).map((d, i) => (
              <span key={d} className={`tl-day${i === 0 ? " is-today" : ""}`} style={{ left: `${pct(d)}%`, width: `${pct(days[i + 1] ?? end) - pct(d)}%` }}>
                {i === 0 ? (pct(days[1]!) > 8 ? <><b>Today</b> {dayLabel.format(d)}</> : null)
                  : i === 1 ? <><b>Tomorrow</b> {dayLabel.format(d)}</> : dayLabel.format(d)}
              </span>
            ))}
          </div>
          <div className="tl-sum" role="columnheader">{metric === "revenuePerDay" ? "Per day" : "Revenue"}</div>
        </div>

        {trucks.map((t) => {
          const route = plans.get(t.id)?.[0];
          const empty = t.availableAt <= now;
          return (
            <div key={t.id} className="tl-row" role="row" tabIndex={0} onClick={() => onOpen(t.id)}
              onKeyDown={(e) => { if (e.key === "Enter") onOpen(t.id); }}>
              <div className="tl-who" role="cell">
                <span className="tl-name"><span className={`eq eq-${t.equipment}`} aria-hidden="true" />{t.name}</span>
                <span className="tl-where">{t.location.city}, {t.location.state} · {empty ? "empty now" : `empty ${shortWhen(t.availableAt)}`}</span>
              </div>
              <div className="tl-track" role="cell">
                <span className="tl-today" style={span(days[0]!, days[1]!)} aria-hidden="true" />
                {days.slice(1).filter((d) => d < end).map((d) => <span key={d} className="tl-grid" style={{ left: `${pct(d)}%` }} aria-hidden="true" />)}
                {!empty && (
                  <span className="tl-busy" style={span(now, t.availableAt)} title={`On current load until ${at(t.availableAt)}`}
                  />
                )}
                {route?.legs.map((leg) => (
                  <span key={leg.load.id} className="tl-legwrap">
                    {leg.deadheadMiles > 0 && (
                      <span className="tl-dh" style={span(leg.departForPickup, leg.arriveAtPickup)}
                        title={`${leg.deadheadMiles} mi empty to ${place(leg.load.origin)}`} />
                    )}
                    <span className={`tl-load${leg.load.rate === null ? " no-rate" : ""}`} style={span(leg.pickupStart, leg.deliveryDone)}
                      title={`${place(leg.load.origin)} → ${place(leg.load.destination)}\nPick up ${at(leg.pickupStart)}\nDeliver ${at(leg.deliveryStart)}\n${leg.load.rate === null ? "No rate posted" : money(leg.load.rate)}`}>
                      {leg.load.origin.city} → {leg.load.destination.city}
                    </span>
                  </span>
                ))}
                {!route && <span className="tl-none">No plan fits this truck's rules</span>}
                <span className="tl-now" style={{ left: `${pct(now)}%` }} aria-hidden="true" />
              </div>
              <div className="tl-sum" role="cell">
                {route ? (
                  <>
                    <span className="tl-money num">
                      {money(route.totals[metric])}{metric === "revenue" && route.totals.revenueIncomplete ? "+" : ""}
                    </span>
                    <span className="tl-rpm num">{rpm(route.totals.totalRpm)}/mi</span>
                  </>
                ) : <span className="dim">—</span>}
              </div>
            </div>
          );
        })}
      </div>
      <p className="tl-legend">
        Each row shows the truck's best plan. <span className="key key-load" /> loaded <span className="key key-dh" /> driving
        empty <span className="key key-busy" /> finishing its current load <span className="key key-now" /> now. Click a truck to
        see all its plans.
      </p>
    </div>
  );
}

