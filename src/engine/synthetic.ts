// Synthetic load board. Stands in for DAT until written API approval arrives:
// realistic lanes, rates and windows, including the gaps real postings have
// (no rate, no trip miles, no weight, no delivery appointment).

import { DEFAULT_TZ, HOUR, localParts, zonedTime } from "./clock";
import { roadMiles } from "./geo";
import type { Equipment, Load, Place, PlanningRules, Truck } from "./types";

export const CITIES: Place[] = [
  { city: "Chicago", state: "IL", lat: 41.88, lon: -87.63 },
  { city: "Joliet", state: "IL", lat: 41.53, lon: -88.08 },
  { city: "Indianapolis", state: "IN", lat: 39.77, lon: -86.16 },
  { city: "Columbus", state: "OH", lat: 39.96, lon: -83.0 },
  { city: "Cincinnati", state: "OH", lat: 39.1, lon: -84.51 },
  { city: "Cleveland", state: "OH", lat: 41.5, lon: -81.69 },
  { city: "Detroit", state: "MI", lat: 42.33, lon: -83.05 },
  { city: "Grand Rapids", state: "MI", lat: 42.96, lon: -85.67 },
  { city: "Milwaukee", state: "WI", lat: 43.04, lon: -87.91 },
  { city: "Minneapolis", state: "MN", lat: 44.98, lon: -93.27 },
  { city: "Des Moines", state: "IA", lat: 41.59, lon: -93.62 },
  { city: "Kansas City", state: "MO", lat: 39.1, lon: -94.58 },
  { city: "St. Louis", state: "MO", lat: 38.63, lon: -90.2 },
  { city: "Omaha", state: "NE", lat: 41.26, lon: -95.93 },
  { city: "Louisville", state: "KY", lat: 38.25, lon: -85.76 },
  { city: "Nashville", state: "TN", lat: 36.16, lon: -86.78 },
  { city: "Memphis", state: "TN", lat: 35.15, lon: -90.05 },
  { city: "Knoxville", state: "TN", lat: 35.96, lon: -83.92 },
  { city: "Atlanta", state: "GA", lat: 33.75, lon: -84.39 },
  { city: "Savannah", state: "GA", lat: 32.08, lon: -81.09 },
  { city: "Charlotte", state: "NC", lat: 35.23, lon: -80.84 },
  { city: "Greensboro", state: "NC", lat: 36.07, lon: -79.79 },
  { city: "Raleigh", state: "NC", lat: 35.78, lon: -78.64 },
  { city: "Columbia", state: "SC", lat: 34.0, lon: -81.03 },
  { city: "Jacksonville", state: "FL", lat: 30.33, lon: -81.66 },
  { city: "Orlando", state: "FL", lat: 28.54, lon: -81.38 },
  { city: "Tampa", state: "FL", lat: 27.95, lon: -82.46 },
  { city: "Miami", state: "FL", lat: 25.76, lon: -80.19 },
  { city: "Birmingham", state: "AL", lat: 33.52, lon: -86.8 },
  { city: "Montgomery", state: "AL", lat: 32.38, lon: -86.3 },
  { city: "Jackson", state: "MS", lat: 32.3, lon: -90.18 },
  { city: "New Orleans", state: "LA", lat: 29.95, lon: -90.07 },
  { city: "Shreveport", state: "LA", lat: 32.53, lon: -93.75 },
  { city: "Little Rock", state: "AR", lat: 34.75, lon: -92.29 },
  { city: "Dallas", state: "TX", lat: 32.78, lon: -96.8 },
  { city: "Fort Worth", state: "TX", lat: 32.76, lon: -97.33 },
  { city: "Houston", state: "TX", lat: 29.76, lon: -95.37 },
  { city: "San Antonio", state: "TX", lat: 29.42, lon: -98.49 },
  { city: "Austin", state: "TX", lat: 30.27, lon: -97.74 },
  { city: "Laredo", state: "TX", lat: 27.53, lon: -99.48 },
  { city: "El Paso", state: "TX", lat: 31.76, lon: -106.49 },
  { city: "Oklahoma City", state: "OK", lat: 35.47, lon: -97.52 },
  { city: "Tulsa", state: "OK", lat: 36.15, lon: -95.99 },
  { city: "Denver", state: "CO", lat: 39.74, lon: -104.99 },
  { city: "Albuquerque", state: "NM", lat: 35.08, lon: -106.65 },
  { city: "Phoenix", state: "AZ", lat: 33.45, lon: -112.07 },
  { city: "Salt Lake City", state: "UT", lat: 40.76, lon: -111.89 },
  { city: "Las Vegas", state: "NV", lat: 36.17, lon: -115.14 },
  { city: "Los Angeles", state: "CA", lat: 34.05, lon: -118.24 },
  { city: "Ontario", state: "CA", lat: 34.06, lon: -117.65 },
  { city: "Fresno", state: "CA", lat: 36.74, lon: -119.79 },
  { city: "Stockton", state: "CA", lat: 37.96, lon: -121.29 },
  { city: "Portland", state: "OR", lat: 45.52, lon: -122.68 },
  { city: "Seattle", state: "WA", lat: 47.61, lon: -122.33 },
  { city: "Harrisburg", state: "PA", lat: 40.27, lon: -76.88 },
  { city: "Allentown", state: "PA", lat: 40.6, lon: -75.49 },
  { city: "Pittsburgh", state: "PA", lat: 40.44, lon: -79.99 },
  { city: "Newark", state: "NJ", lat: 40.74, lon: -74.17 },
  { city: "Baltimore", state: "MD", lat: 39.29, lon: -76.61 },
  { city: "Richmond", state: "VA", lat: 37.54, lon: -77.44 },
  { city: "Boston", state: "MA", lat: 42.36, lon: -71.06 },
  { city: "Albany", state: "NY", lat: 42.65, lon: -73.75 },
  { city: "Buffalo", state: "NY", lat: 42.89, lon: -78.88 },
];

/** Freight-heavy markets post more loads; this skews origins the way real boards do. */
const HUB_WEIGHT: Record<string, number> = {
  Chicago: 5, Atlanta: 4, Dallas: 4, "Los Angeles": 4, Ontario: 3, Houston: 3,
  Memphis: 3, Indianapolis: 3, Columbus: 3, Joliet: 3, Laredo: 2, Harrisburg: 2,
  Allentown: 2, Charlotte: 2, Nashville: 2, "Kansas City": 2, "St. Louis": 2,
  Jacksonville: 2, Savannah: 2, Phoenix: 2, Newark: 2, Stockton: 2, Fresno: 2,
};

const BASE_RPM: Record<Equipment, number> = { van: 2.05, reefer: 2.45, flatbed: 2.6 };
/** Short hauls pay more per mile; long hauls less. */
const SHORT_HAUL_MINIMUM = 450;

const BROKERS = [
  "Northline Logistics", "Prairie Freight Brokers", "Bluewater Transport Group",
  "Summit Freight Solutions", "Keystone Load Partners", "Redline Logistics",
  "Copperleaf Freight", "Ironbridge Brokerage", "Lakeshore Shipping Co.",
  "Granite Peak Logistics", "Harborview Freight", "Mesa Freight Network",
];

const COMMODITIES: Record<Equipment, string[]> = {
  van: ["Paper products", "Consumer goods", "Beverages", "Auto parts", "Packaging", "Retail mixed"],
  reefer: ["Produce", "Frozen foods", "Dairy", "Meat", "Floral"],
  flatbed: ["Steel coils", "Lumber", "Building materials", "Machinery", "Pipe"],
};

/** Small deterministic PRNG so the same seed gives the same board (tests, demos). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function weightedCity(rand: () => number): Place {
  const total = CITIES.reduce((s, c) => s + (HUB_WEIGHT[c.city] ?? 1), 0);
  let x = rand() * total;
  for (const c of CITIES) {
    x -= HUB_WEIGHT[c.city] ?? 1;
    if (x <= 0) return c;
  }
  return CITIES[0]!;
}

let loadCounter = 0;

export function makeLoad(rand: () => number, now: number, tz = DEFAULT_TZ): Load {
  const equipment: Equipment = rand() < 0.6 ? "van" : rand() < 0.6 ? "reefer" : "flatbed";
  const origin = weightedCity(rand);
  let destination = weightedCity(rand);
  while (destination === origin) destination = pick(rand, CITIES);

  const miles = roadMiles(origin, destination);
  const lengthFactor = miles < 250 ? 1.45 : miles < 500 ? 1.15 : miles > 1200 ? 0.9 : 1;
  const rpm = BASE_RPM[equipment] * lengthFactor * (0.8 + rand() * 0.45);
  const rate = Math.round(Math.max(SHORT_HAUL_MINIMUM, miles * rpm) / 25) * 25;

  // Pickup on one of the next 4 local days, 1–4h window starting 05:00–15:00.
  const today = localParts(now, tz);
  const dayOffset = Math.floor(rand() * 4);
  const startHour = 5 + Math.floor(rand() * 11);
  const d = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  let pickupEarliest = zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), startHour, tz);
  if (pickupEarliest < now) pickupEarliest = now + Math.ceil(rand() * 4) * HOUR;
  const pickupLatest = pickupEarliest + (1 + Math.floor(rand() * 4)) * HOUR;

  // Most loads post a delivery appointment with generous slack over drive time.
  let deliveryEarliest: number | null = null;
  let deliveryLatest: number | null = null;
  if (rand() < 0.75) {
    const transitHours = miles / 50 + Math.floor(miles / 550) * 10 + 2;
    deliveryEarliest = pickupEarliest + Math.round(transitHours) * HOUR;
    deliveryLatest = deliveryEarliest + (6 + Math.floor(rand() * 30)) * HOUR;
  }

  const id = `L${(++loadCounter).toString().padStart(5, "0")}`;
  return {
    id,
    sourceId: `SYN-${Math.floor(rand() * 1e8).toString(36).toUpperCase()}`,
    source: "synthetic",
    equipment,
    origin,
    destination,
    pickupEarliest,
    pickupLatest,
    deliveryEarliest,
    deliveryLatest,
    // Real boards: a good share of loads post no rate, some omit miles or weight.
    rate: rand() < 0.22 ? null : rate,
    tripMiles: rand() < 0.15 ? null : miles + Math.round((rand() - 0.5) * miles * 0.06),
    weightLbs: rand() < 0.1 ? null : Math.round((18000 + rand() * 26000) / 500) * 500,
    lengthFt: rand() < 0.7 ? 53 : pick(rand, [24, 36, 40, 48]),
    broker: pick(rand, BROKERS),
    brokerPhone: `(555) ${100 + Math.floor(rand() * 900)}-${1000 + Math.floor(rand() * 9000)}`,
    postedAt: now - Math.floor(rand() * 6) * HOUR,
    commodity: rand() < 0.2 ? null : pick(rand, COMMODITIES[equipment]),
  };
}

export function makeLoadBoard(seed: number, now: number, count = 2500): Load[] {
  const rand = rng(seed);
  return Array.from({ length: count }, () => makeLoad(rand, now));
}

/**
 * Simulate the board moving between refreshes: some loads get covered and
 * disappear, expired ones drop off, new ones get posted.
 */
export function churnLoadBoard(board: Load[], rand: () => number, now: number): Load[] {
  const kept = board.filter((l) => l.pickupLatest > now && rand() > 0.08);
  const fresh = Array.from({ length: Math.round(board.length * 0.1) }, () => makeLoad(rand, now));
  return [...kept, ...fresh];
}

export const DEFAULT_RULES: PlanningRules = {
  minLoadedRpm: 0,
  maxDeadheadMiles: 150,
  maxLoadsPerRoute: 3,
  dwellHours: 2,
  avgSpeedMph: 50,
  driveHoursBeforeRest: 11,
  restHours: 10,
  noSameDayPickupAfterHour: 12,
  nextDayStartHour: 6,
  avoidStates: [],
  homeBase: null,
  maxMilesFromHomeAtEnd: null,
  excludeLoadsWithoutRate: false,
};

function city(name: string): Place {
  const c = CITIES.find((x) => x.city === name);
  if (!c) throw new Error(`Unknown city ${name}`);
  return c;
}

export function sampleTrucks(now: number): Truck[] {
  const t = (
    id: string, name: string, driver: string, equipment: Equipment, at: string,
    hoursUntilAvailable: number, rules: Partial<PlanningRules> = {},
  ): Truck => ({
    id, name, driver, equipment,
    location: city(at),
    availableAt: now + hoursUntilAvailable * HOUR,
    maxWeightLbs: 45000,
    trailerLengthFt: 53,
    rules: { ...DEFAULT_RULES, ...rules },
  });
  return [
    t("T101", "Truck 101", "Marcus R.", "van", "Chicago", 0),
    t("T102", "Truck 102", "Dana K.", "van", "Atlanta", 3, { minLoadedRpm: 2 }),
    t("T103", "Truck 103", "Luis M.", "reefer", "Dallas", 1, { maxDeadheadMiles: 100 }),
    t("T104", "Truck 104", "Priya S.", "flatbed", "Houston", 0, { avoidStates: ["CA", "NY"] }),
    t("T105", "Truck 105", "Jerome W.", "van", "Columbus", 6, {
      homeBase: city("Columbus"), maxMilesFromHomeAtEnd: 250,
    }),
    t("T106", "Truck 106", "Anna B.", "reefer", "Los Angeles", 2, { maxLoadsPerRoute: 2 }),
    t("T107", "Truck 107", "Sam O.", "van", "Memphis", 0, { excludeLoadsWithoutRate: true }),
    t("T108", "Truck 108", "Ivan P.", "flatbed", "Kansas City", 4, { maxDeadheadMiles: 200 }),
  ];
}
