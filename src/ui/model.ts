// What every screen reads and calls, whether the data comes from the server
// (the real app) or from the in-browser sample board (the shareable demo).

import type { RouteCandidate, SortKey, Truck } from "../engine/types";

export type MarkStatus = "called" | "booked" | "rejected" | "unavailable";

export interface LoadMark {
  status: MarkStatus;
  note: string;
  truckId: string | null;
  updatedAt: number;
  by: string | null;
}

export const MARK_LABEL: Record<MarkStatus, string> = {
  called: "Called",
  booked: "Booked",
  rejected: "Rejected",
  unavailable: "Gone",
};

export interface BoardModel {
  mode: "demo" | "server";
  trucks: Truck[];
  plans: Map<string, RouteCandidate[]>;
  marks: Record<string, LoadMark>;
  sortBy: SortKey;
  setSortBy: (s: SortKey) => void;
  /** Local clock, ticking every second. */
  now: number;
  /** When the plans on screen were built from fresh load data; null before the first refresh. */
  lastRefreshed: number | null;
  stale: boolean;
  /** Latest refresh problem to show the dispatcher, if any. */
  feedError: string | null;
  loadCount: number | null;
  refresh: () => Promise<void>;
  saveTruck: (t: Truck, isNew: boolean) => Promise<void>;
  removeTruck: (id: string) => Promise<void>;
  setMark: (loadId: string, status: MarkStatus | null, truckId: string | null) => Promise<void>;
  /** Demo-only controls. */
  demo?: { paused: boolean; setPaused: (p: boolean) => void; resetTrucks: () => void };
}

/** A fresh truck for the "Add truck" form. */
export function blankTruck(existing: Truck[], template: Truck["rules"], location: Truck["location"]): Truck {
  return {
    id: "",
    name: `Truck ${existing.length + 1}`,
    driver: "",
    equipment: "van",
    location,
    availableAt: Date.now(),
    maxWeightLbs: 45000,
    trailerLengthFt: 53,
    rules: template,
  };
}
