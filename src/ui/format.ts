import { DEFAULT_TZ } from "../engine/clock";
import type { Place } from "../engine/types";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const when = new Intl.DateTimeFormat("en-US", {
  timeZone: DEFAULT_TZ, weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit",
});
const clock = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit", second: "2-digit" });

export const money = (n: number) => usd0.format(n);
export const miles = (n: number) => `${num0.format(n)} mi`;
export const rpm = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
export const at = (ms: number) => when.format(ms);
export const clockTime = (ms: number) => clock.format(ms);
export const place = (p: Place) => `${p.city}, ${p.state}`;

export function duration(hours: number): string {
  const d = Math.floor(hours / 24);
  const h = Math.round(hours - d * 24);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export function hourLabel(h: number): string {
  if (h === 0) return "midnight";
  if (h === 12) return "noon";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}
