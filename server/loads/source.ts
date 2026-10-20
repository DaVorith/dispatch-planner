// The only thing the rest of the server knows about a load board. Each
// provider (synthetic now, DAT once approved) implements this and maps its
// own records into the canonical Load shape; nothing else changes when the
// provider does.

import type { Equipment, Load, Place } from "../../src/engine/types";

/** A load as a provider returns it, before it gets our database id. */
export type SourceLoad = Omit<Load, "id">;

export interface LoadSearch {
  equipment: Equipment;
  origin: Place;
  /** Pickups within this many miles of `origin`. */
  radiusMiles: number;
  /** Pickup window overlap, epoch ms. */
  pickupFrom: number;
  pickupTo: number;
}

export interface LoadSource {
  readonly name: "synthetic" | "dat";
  /** Run one search for one company. Throws on provider errors; callers record the failure. */
  search(orgId: string, query: LoadSearch, signal?: AbortSignal): Promise<SourceLoad[]>;
}

export class SourceNotConfiguredError extends Error {}
