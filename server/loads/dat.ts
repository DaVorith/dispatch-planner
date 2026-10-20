// DAT provider. Stays switched off until DAT approves API access in writing
// and LOAD_SOURCE=dat is set with credentials.
//
// IMPORTANT: DAT's API documentation is only available after developer-portal
// access is granted, so the endpoint paths, auth flow and field names below
// are ASSUMPTIONS, marked "ASSUMED". When the real docs arrive, only this file
// should need to change: the request in `search()` and the field mapping in
// `mapDatLoad()`. The tests in dat.test.ts pin the mapping rules (what we do
// with missing rates, miles, weights) that must hold whatever the field names.

import { z } from "zod";
import type { Config } from "../config";
import { CITIES } from "../../src/engine/synthetic";
import type { Equipment, Place } from "../../src/engine/types";
import { type LoadSearch, type LoadSource, type SourceLoad, SourceNotConfiguredError } from "./source";

/** ASSUMED shape of one DAT load-search result. Replace with the real schema. */
const DatLoad = z.object({
  id: z.string(),
  equipmentType: z.string(),
  origin: z.object({ city: z.string(), state: z.string(), latitude: z.number().optional(), longitude: z.number().optional() }),
  destination: z.object({ city: z.string(), state: z.string(), latitude: z.number().optional(), longitude: z.number().optional() }),
  pickupDateEarliest: z.string(),
  pickupDateLatest: z.string().optional(),
  deliveryDateEarliest: z.string().optional(),
  deliveryDateLatest: z.string().optional(),
  rateUsd: z.number().nullable().optional(),
  tripMiles: z.number().nullable().optional(),
  weightPounds: z.number().nullable().optional(),
  lengthFeet: z.number().nullable().optional(),
  commodity: z.string().nullable().optional(),
  poster: z.object({ companyName: z.string(), phone: z.string().optional() }),
  postedAt: z.string().optional(),
});
export type DatLoadRecord = z.infer<typeof DatLoad>;

/** ASSUMED DAT equipment codes for the three trailer types we plan for. */
const EQUIPMENT_CODES: Record<Equipment, string[]> = {
  van: ["V", "VAN"],
  reefer: ["R", "REEFER"],
  flatbed: ["F", "FLATBED"],
};

function equipmentFrom(code: string): Equipment | null {
  const c = code.toUpperCase();
  for (const [eq, codes] of Object.entries(EQUIPMENT_CODES) as [Equipment, string[]][]) {
    if (codes.includes(c)) return eq;
  }
  return null;
}

function placeFrom(p: { city: string; state: string; latitude?: number; longitude?: number }): Place | null {
  if (p.latitude !== undefined && p.longitude !== undefined) {
    return { city: p.city, state: p.state.toUpperCase(), lat: p.latitude, lon: p.longitude };
  }
  // Without coordinates we can only place known cities; a geocoder replaces this later.
  const known = CITIES.find((c) => c.city.toLowerCase() === p.city.toLowerCase() && c.state === p.state.toUpperCase());
  return known ?? null;
}

const ms = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

/**
 * Map one provider record to our canonical load, or null when it can't be
 * planned with (unknown equipment, unplaceable city, no pickup date).
 * Never invents values: a missing rate, mileage or weight stays null.
 */
export function mapDatLoad(raw: unknown, now: number): SourceLoad | null {
  const parsed = DatLoad.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const equipment = equipmentFrom(r.equipmentType);
  const origin = placeFrom(r.origin);
  const destination = placeFrom(r.destination);
  const pickupEarliest = ms(r.pickupDateEarliest);
  if (!equipment || !origin || !destination || pickupEarliest === null) return null;
  // Boards often post a pickup date with no window; treat it as a 4-hour window.
  const pickupLatest = ms(r.pickupDateLatest) ?? pickupEarliest + 4 * 3_600_000;
  return {
    sourceId: r.id,
    source: "dat",
    equipment,
    origin,
    destination,
    pickupEarliest,
    pickupLatest,
    deliveryEarliest: ms(r.deliveryDateEarliest),
    deliveryLatest: ms(r.deliveryDateLatest),
    rate: r.rateUsd != null && r.rateUsd > 0 ? r.rateUsd : null,
    tripMiles: r.tripMiles != null && r.tripMiles > 0 ? r.tripMiles : null,
    weightLbs: r.weightPounds ?? null,
    lengthFt: r.lengthFeet ?? null,
    broker: r.poster.companyName,
    brokerPhone: r.poster.phone ?? "",
    postedAt: ms(r.postedAt) ?? now,
    commodity: r.commodity ?? null,
  };
}

export class DatLoadSource implements LoadSource {
  readonly name = "dat" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private config: Config, private fetchImpl: typeof fetch = fetch) {
    if (!config.DAT_API_BASE || !config.DAT_CLIENT_ID || !config.DAT_CLIENT_SECRET) {
      throw new SourceNotConfiguredError(
        "LOAD_SOURCE=dat needs DAT_API_BASE, DAT_CLIENT_ID and DAT_CLIENT_SECRET. Leave LOAD_SOURCE=synthetic until DAT approves access.",
      );
    }
  }

  async search(_orgId: string, q: LoadSearch, signal?: AbortSignal): Promise<SourceLoad[]> {
    const token = await this.accessToken(signal);
    // ASSUMED endpoint and request body.
    const res = await this.fetchImpl(new URL("/search/loads", this.config.DAT_API_BASE), {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        equipmentTypes: EQUIPMENT_CODES[q.equipment],
        origin: { city: q.origin.city, state: q.origin.state, latitude: q.origin.lat, longitude: q.origin.lon },
        originRadiusMiles: q.radiusMiles,
        pickupDateFrom: new Date(q.pickupFrom).toISOString(),
        pickupDateTo: new Date(q.pickupTo).toISOString(),
      }),
    });
    if (res.status === 429) throw new Error("DAT rate limit reached; will retry next cycle");
    if (!res.ok) throw new Error(`DAT search failed with HTTP ${res.status}`);
    const body = (await res.json()) as { matches?: unknown[] };
    const now = Date.now();
    return (body.matches ?? []).flatMap((m) => mapDatLoad(m, now) ?? []);
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    // ASSUMED OAuth2 client-credentials token endpoint.
    const res = await this.fetchImpl(new URL("/token", this.config.DAT_API_BASE), {
      method: "POST",
      signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.DAT_CLIENT_ID!,
        client_secret: this.config.DAT_CLIENT_SECRET!,
        ...(this.config.DAT_USERNAME ? { username: this.config.DAT_USERNAME } : {}),
      }),
    });
    if (!res.ok) throw new Error(`DAT sign-in failed with HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
}
