// Time-of-day helpers in the planner's timezone. Rules like "no pickup after a
// delivery that ends past noon" are about the local clock, not UTC.

export const HOUR = 3_600_000;
export const DEFAULT_TZ = "America/Chicago";

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

/** Epoch ms for a wall-clock time in `tz`. */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour);
  // Correct by the zone's offset at the guess; a second pass settles DST edges.
  let ms = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(ms, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    ms += guess - asUtc;
  }
  return ms;
}

export function localHour(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return p.hour + p.minute / 60;
}

/** `hour` o'clock on the local day after `ms`. */
export function nextDayAt(ms: number, hour: number, tz: string): number {
  const p = localParts(ms, tz);
  const nextDay = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTime(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    hour,
    tz,
  );
}
