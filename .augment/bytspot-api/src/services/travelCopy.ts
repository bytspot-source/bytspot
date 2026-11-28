/**
 * Guest-facing travel phrases. A straight-line estimate is never spoken as an
 * exact duration. A MapKit drive the phone already measured is preferred and
 * named as an Apple Maps estimate. Ranking does not read these strings.
 */

export type GuestTravelBasis = 'estimate' | 'apple_maps';

export const TRAVEL_TIME_UNAVAILABLE = 'Travel time unavailable.';

/** Whole minutes a guest may be told. Null when the value is missing or nonsense. */
export function knownDriveMinutes(value: number | null | undefined): number | null {
  if (value == null || !Number.isInteger(value) || value < 0 || value > 180) return null;
  return value;
}

export function guestTravelLine(minutes: number, basis: GuestTravelBasis): string {
  const n = Math.max(0, Math.round(minutes));
  if (basis === 'apple_maps') return `about ${n} min (Apple Maps estimate)`;
  return `about ${n} min (estimate)`;
}
