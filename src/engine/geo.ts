import type { Place } from "./types";

const EARTH_RADIUS_MI = 3958.8;
/** Roads aren't straight lines; typical US highway circuity vs. great-circle distance. */
export const ROAD_CIRCUITY = 1.18;

export function greatCircleMiles(a: Place, b: Place): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

/** Estimated road miles. A routing provider replaces this in a later phase. */
export function roadMiles(a: Place, b: Place): number {
  return Math.round(greatCircleMiles(a, b) * ROAD_CIRCUITY);
}

export function placeLabel(p: Place): string {
  return `${p.city}, ${p.state}`;
}
