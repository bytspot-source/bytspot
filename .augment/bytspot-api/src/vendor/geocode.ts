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
 * Google's location_type, which is the field most integrations discard.
 *
 * Every provider returns something for almost any input: ask for a street that
 * does not exist and you get the centre of the town, with no error. Storing
 * that as a restaurant's pin puts it a mile from the door and nothing
 * downstream can tell.
 *
 * RANGE_INTERPOLATED is a point estimated between two known house numbers —
 * street-accurate, not rooftop. GEOMETRIC_CENTER is the midpoint of a line or
 * polygon, so it is street-accurate for a road and no better than a locality
 * for anything larger; it is read down to locality rather than up, because
 * over-stating precision is the failure this field exists to prevent.
 */
function precisionFrom(locationType: string, types: string[]): GeocodePrecision {
  if (locationType === 'ROOFTOP') return 'rooftop';
  if (locationType === 'RANGE_INTERPOLATED') return 'street';
  if (locationType === 'GEOMETRIC_CENTER') return types.includes('route') ? 'street' : 'locality';
  if (types.some((type) => type === 'locality' || type === 'postal_code' || type === 'sublocality')) {
    return 'locality';
  }
  return 'region';
}

interface GoogleResult {
  formatted_address?: string;
  types?: string[];
  geometry?: { location?: { lat?: number; lng?: number }; location_type?: string };
}

export type GeocodeOutcome =
  | { ok: true; candidates: GeocodeCandidate[] }
  | { ok: false; reason: 'unconfigured' | 'upstream' };

/** Injectable so tests exercise the mapping without reaching the network. */
export const geocodeFetch = { call: globalThis.fetch.bind(globalThis) };

export function geocodeIsConfigured(): boolean {
  return Boolean(config.googlePlacesApiKey);
}

export async function geocode(query: string): Promise<GeocodeOutcome> {
  if (!geocodeIsConfigured()) return { ok: false, reason: 'unconfigured' };

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', config.googlePlacesApiKey);

  try {
    const response = await geocodeFetch.call(url.toString(), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, reason: 'upstream' };

    const body = (await response.json()) as { status?: string; results?: GoogleResult[] };
    // ZERO_RESULTS is a real answer: the address does not exist. Anything else
    // non-OK is our problem, not the vendor's, and must not read as "no match".
    if (body.status === 'ZERO_RESULTS') return { ok: true, candidates: [] };
    if (body.status !== 'OK') return { ok: false, reason: 'upstream' };

    return { ok: true, candidates: mapCandidates(body.results ?? []) };
  } catch {
    return { ok: false, reason: 'upstream' };
  }
}

export function mapCandidates(results: GoogleResult[]): GeocodeCandidate[] {
  const candidates: GeocodeCandidate[] = [];
  for (const result of results) {
    const lat = result.geometry?.location?.lat;
    const lng = result.geometry?.location?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    // Null Island. Every provider emits it eventually, and it is always a
    // failed lookup that forgot to say so.
    if (lat === 0 && lng === 0) continue;

    candidates.push({
      formatted: result.formatted_address ?? '',
      lat,
      lng,
      precision: precisionFrom(result.geometry?.location_type ?? '', result.types ?? []),
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
