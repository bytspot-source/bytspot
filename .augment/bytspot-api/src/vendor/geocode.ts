import { config } from '../config';
import { locationKind, type LocationKindId } from './contract';

/**
 * Address to candidate pins.
 *
 * Server-side because a geocoding key in a static bundle is a public key: it
 * would be extracted and spent within a day of the console shipping. Proxying
 * also puts the rate limit and the provider's caching terms somewhere we
 * control.
 */

export type GeocodePrecision = 'rooftop' | 'street' | 'locality' | 'region';

const PRECISION_RANK: Record<GeocodePrecision, number> = {
  rooftop: 3,
  street: 2,
  locality: 1,
  region: 0,
};

export interface GeocodeCandidate {
  formatted: string;
  lat: number;
  lng: number;
  precision: GeocodePrecision;
  timezone?: string;
}

/**
 * The precision a kind needs, which is not the same for all of them.
 *
 * When the guest travels, the pin is a destination they navigate to, so a town
 * centroid is a wrong answer wearing a right one's clothes. When the vendor
 * travels, the pin is the centre of a radius measured in miles, and a centroid
 * is legitimate — a visiting provider should not have to publish their street
 * to say which town they work in.
 *
 * This duplicates a rule the console also applies. The console applies it to
 * explain; this applies it to decide. A client-side check is a courtesy, not a
 * control.
 */
export function requiredPrecisionFor(kind: LocationKindId): GeocodePrecision {
  return locationKind(kind)?.fulfillment === 'vendorTravels' ? 'locality' : 'street';
}

export function precisionSufficientFor(kind: LocationKindId, precision: GeocodePrecision): boolean {
  return PRECISION_RANK[precision] >= PRECISION_RANK[requiredPrecisionFor(kind)];
}

/**
 * Precision from the place's types, which is all Places reports.
 *
 * Every provider returns something for almost any input: ask for a street that
 * does not exist and you get the centre of the town, with no error. Storing
 * that as a restaurant's pin puts it a mile from the door and nothing
 * downstream can tell.
 *
 * A building or a business is its own pin. A street address may be estimated
 * between two known house numbers, so it is street-accurate, not rooftop; the
 * types are read down rather than up, because over-stating precision is the
 * failure this field exists to prevent.
 */
function precisionFrom(types: string[]): GeocodePrecision {
  if (types.some((type) => type === 'premise' || type === 'subpremise' || type === 'establishment' || type === 'point_of_interest')) {
    return 'rooftop';
  }
  if (types.some((type) => type === 'street_address' || type === 'route' || type === 'intersection')) return 'street';
  if (types.some((type) => type === 'locality' || type === 'postal_code' || type === 'sublocality' || type === 'neighborhood')) {
    return 'locality';
  }
  return 'region';
}

interface GooglePlace {
  formattedAddress?: string;
  types?: string[];
  location?: { latitude?: number; longitude?: number };
  timeZone?: { id?: string };
}

export type GeocodeOutcome =
  | { ok: true; candidates: GeocodeCandidate[] }
  | { ok: false; reason: 'unconfigured' | 'upstream' };

/** Injectable so tests exercise the mapping without reaching the network. */
export const geocodeFetch = { call: globalThis.fetch.bind(globalThis) };

export function geocodeIsConfigured(): boolean {
  return Boolean(config.googlePlacesApiKey);
}

const PLACES_BASE = 'https://places.googleapis.com/v1';

/**
 * Places API (New), not the Geocoding API: the key the rest of the API already
 * uses for Places is the one the vendor console has, and it returns the place's
 * time zone in the same call.
 */
async function placesPost(path: string, body: unknown, fieldMask: string): Promise<{ places?: GooglePlace[] } | undefined> {
  const response = await geocodeFetch.call(`${PLACES_BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googlePlacesApiKey,
      'X-Goog-FieldMask': fieldMask,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return undefined;
  return (await response.json()) as { places?: GooglePlace[] };
}

export async function geocode(query: string): Promise<GeocodeOutcome> {
  if (!geocodeIsConfigured()) return { ok: false, reason: 'unconfigured' };

  try {
    const body = await placesPost(
      'places:searchText',
      { textQuery: query, maxResultCount: 5 },
      'places.formattedAddress,places.location,places.types,places.timeZone',
    );
    // A refusal is our problem, not the vendor's, and must not read as "no match".
    if (!body) return { ok: false, reason: 'upstream' };
    // No places is a real answer: the address does not exist.
    return { ok: true, candidates: mapCandidates(body.places ?? []) };
  } catch {
    return { ok: false, reason: 'upstream' };
  }
}

/** Only a zone this runtime can format in; anything else would yield no slots. */
export function knownTimezone(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The IANA zone a pin keeps, from the nearest place Google knows.
 *
 * A window's slots are computed in the place's own time zone, and a place
 * without one publishes nothing. Undefined on any failure: a guessed zone would
 * sell a 7pm table at 4pm.
 */
export async function timezoneAt(lat: number, lng: number): Promise<string | undefined> {
  if (!geocodeIsConfigured()) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return undefined;
  try {
    const body = await placesPost(
      'places:searchNearby',
      { maxResultCount: 1, locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 50_000 } } },
      'places.timeZone',
    );
    return knownTimezone(body?.places?.[0]?.timeZone?.id);
  } catch {
    return undefined;
  }
}

export function mapCandidates(places: GooglePlace[]): GeocodeCandidate[] {
  const candidates: GeocodeCandidate[] = [];
  for (const place of places) {
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    // Null Island. Every provider emits it eventually, and it is always a
    // failed lookup that forgot to say so.
    if (lat === 0 && lng === 0) continue;

    candidates.push({
      formatted: place.formattedAddress ?? '',
      lat,
      lng,
      precision: precisionFrom(place.types ?? []),
      timezone: knownTimezone(place.timeZone?.id),
    });
  }
  // Most precise first, which is the order the console offers them in.
  return candidates.sort((a, b) => PRECISION_RANK[b.precision] - PRECISION_RANK[a.precision]);
}

/**
 * Every reason a candidate cannot become this kind of location's pin.
 *
 * Returned as vendor-readable strings because they are shown, and computed here
 * because the console cannot be trusted to have computed them.
 */
export function candidateBlockers(kind: LocationKindId, candidate: GeocodeCandidate): string[] {
  if (!locationKind(kind)) return [`${kind} is not a location kind`];

  const blockers: string[] = [];
  if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) {
    blockers.push('That result has no usable coordinate');
  } else if (Math.abs(candidate.lat) > 90 || Math.abs(candidate.lng) > 180) {
    blockers.push('That result is not a real coordinate');
  } else if (candidate.lat === 0 && candidate.lng === 0) {
    blockers.push('That result came back empty');
  }

  if (!precisionSufficientFor(kind, candidate.precision)) {
    blockers.push(
      requiredPrecisionFor(kind) === 'street'
        ? 'Guests navigate to this pin, so it needs a street address, not just a town'
        : 'That is too broad to measure a travel radius from',
    );
  }
  return blockers;
}
