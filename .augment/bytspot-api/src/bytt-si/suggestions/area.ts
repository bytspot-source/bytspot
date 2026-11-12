import { distanceMeters } from '../core/geo';

/** Launch market anchor. Midtown Atlanta, not a live geocode of the guest. */
export const LAUNCH_MARKET = { label: 'Midtown Atlanta', lat: 33.781, lng: -84.3833 } as const;

/** Inside this radius of the anchor, the shared coordinates are called Midtown. */
export const MIDTOWN_RADIUS_METERS = 2_500;
/** Inside this radius, and outside Midtown, the shared coordinates are called Atlanta. */
export const ATLANTA_RADIUS_METERS = 25_000;

export type AreaBasis = 'coordinates' | 'launch_market';

export interface ClassifiedArea {
  label: string | null;
  basis: AreaBasis;
  /** Guest-facing sentence. States when the area is an assumption. */
  sentence: string;
}

/**
 * Name the area from coordinates, or say the launch market when none were shared.
 * A point near the anchor is Midtown; a point in the metro is Atlanta; anywhere
 * else stays "the location you shared" with no neighborhood name.
 */
export function classifyArea(location: { lat: number; lng: number } | null): ClassifiedArea {
  if (!location) {
    return {
      label: LAUNCH_MARKET.label,
      basis: 'launch_market',
      sentence: "Location wasn't shared, so this assumes the launch market, Midtown Atlanta.",
    };
  }
  const meters = distanceMeters(
    { latitude: location.lat, longitude: location.lng },
    { latitude: LAUNCH_MARKET.lat, longitude: LAUNCH_MARKET.lng },
  );
  if (meters <= MIDTOWN_RADIUS_METERS) {
    return { label: 'Midtown', basis: 'coordinates', sentence: 'Using the location you shared in Midtown.' };
  }
  if (meters <= ATLANTA_RADIUS_METERS) {
    return { label: 'Atlanta', basis: 'coordinates', sentence: 'Using the location you shared in Atlanta.' };
  }
  return { label: null, basis: 'coordinates', sentence: 'Using the location you shared.' };
}
