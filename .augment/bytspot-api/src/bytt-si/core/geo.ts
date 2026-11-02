import type { LatLng } from '../ports/types';

export const METERS_PER_MILE = 1609.344;
export const milesToMeters = (miles: number) => Math.round(miles * METERS_PER_MILE);

export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Walk if under ~1.2 km, else drive (ride hand-off). */
export const travelModeFor = (meters: number): 'walk' | 'drive' => (meters <= 1200 ? 'walk' : 'drive');

/** Straight-line fallback when routing is unavailable: 1.3x detour, walk 80 m/min, drive 400 m/min + 10 min pickup. Always basis 'estimate'. */
export function estimateTravel(from: LatLng, to: LatLng): { minutes: number; meters: number; mode: 'walk' | 'drive'; basis: 'estimate' } {
  const meters = Math.round(distanceMeters(from, to) * 1.3);
  const mode = travelModeFor(meters);
  const minutes = mode === 'walk' ? Math.max(1, Math.ceil(meters / 80)) : Math.ceil(meters / 400) + 10;
  return { minutes, meters, mode, basis: 'estimate' };
}
