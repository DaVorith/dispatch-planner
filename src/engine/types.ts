// Canonical data model for the route planner. Everything downstream (engine,
// metrics, UI) works on these shapes, never on vendor-specific load records.

export type Equipment = "van" | "reefer" | "flatbed";

export interface Place {
  city: string;
  state: string;
  lat: number;
  lon: number;
}

/** Where a value came from. "estimated" values are computed by us, not given by the source. */
export type Provenance = "source" | "estimated";

export interface Load {
  id: string;
  /** Identifier from the originating load board, kept for traceability. */
  sourceId: string;
  source: "synthetic" | "dat";
  equipment: Equipment;
  origin: Place;
  destination: Place;
  /** Epoch ms. Pickup must start inside [pickupEarliest, pickupLatest]. */
  pickupEarliest: number;
  pickupLatest: number;
  /** Optional delivery appointment window; null when the source gives none. */
  deliveryEarliest: number | null;
  deliveryLatest: number | null;
  /** Posted all-in rate in USD; null when the poster did not include one. */
  rate: number | null;
  /** Loaded trip miles; null when the source gives none (we then estimate). */
  tripMiles: number | null;
  weightLbs: number | null;
  lengthFt: number | null;
  broker: string;
  brokerPhone: string;
  postedAt: number;
  commodity: string | null;
}

export interface Truck {
  id: string;
  name: string;
  driver: string;
  equipment: Equipment;
  /** Last-known position (Samsara later, manual for now). */
  location: Place;
  /** When the truck is empty and ready to roll, epoch ms. */
  availableAt: number;
  maxWeightLbs: number;
  trailerLengthFt: number;
  rules: PlanningRules;
}

export interface PlanningRules {
  /** Lowest acceptable loaded RPM for any single load (USD/mi). 0 = no floor. */
  minLoadedRpm: number;
  /** Max empty miles to reach any pickup. */
  maxDeadheadMiles: number;
  /** Loads per route to plan ahead (1–4). */
  maxLoadsPerRoute: number;
  /** Hours spent at each pickup and each delivery (loading/unloading buffer). */
  dwellHours: number;
  /** Average road speed used for drive-time estimates, mph. */
  avgSpeedMph: number;
  /** Planning buffer, not HOS: after this many drive hours, add a rest break. */
  driveHoursBeforeRest: number;
  restHours: number;
  /**
   * If a delivery finishes at or after this hour (0–23, local to the planner),
   * don't plan another pickup the same day. null disables the rule.
   */
  noSameDayPickupAfterHour: number | null;
  /** Hour the truck can start again the next morning when the rule above applies. */
  nextDayStartHour: number;
  /** States the truck should never pick up or deliver in. */
  avoidStates: string[];
  /** Optional preferred final destination (e.g. driver's home). */
  homeBase: Place | null;
  /** When set, the last drop must be within this many miles of homeBase. */
  maxMilesFromHomeAtEnd: number | null;
  /** Leave loads without a posted rate out of route building. */
  excludeLoadsWithoutRate: boolean;
}

export interface RouteLeg {
  load: Load;
  deadheadMiles: number;
  loadedMiles: number;
  loadedMilesProvenance: Provenance;
  /** Planned timeline for this leg, epoch ms. */
  departForPickup: number;
  arriveAtPickup: number;
  pickupStart: number;
  pickupDone: number;
  arriveAtDelivery: number;
  deliveryStart: number;
  deliveryDone: number;
  /** When the truck is ready for the next load (after same-day rule). */
  readyForNext: number;
  /** Revenue per loaded mile, or null when the load has no rate. */
  loadedRpm: number | null;
  notes: string[];
}

export interface RouteTotals {
  revenue: number;
  /** True when one or more loads have no posted rate, so revenue is a floor. */
  revenueIncomplete: boolean;
  loadedMiles: number;
  deadheadMiles: number;
  totalMiles: number;
  /** Revenue / loaded miles. */
  loadedRpm: number | null;
  /** Revenue / (loaded + deadhead) miles. */
  totalRpm: number | null;
  /** Revenue / elapsed days; how much the truck grosses per day on this plan. */
  revenuePerDay: number;
  /** From truck availability to final delivery completed, hours. */
  elapsedHours: number;
  finishAt: number;
  finishPlace: Place;
}

export interface RouteCandidate {
  id: string;
  truckId: string;
  legs: RouteLeg[];
  totals: RouteTotals;
  flags: string[];
}

export type SortKey = "totalRpm" | "revenue" | "revenuePerDay" | "leastDeadhead";
