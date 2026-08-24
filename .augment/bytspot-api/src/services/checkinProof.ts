/** How close a member must be for a check-in to count as evidence. Loose
 *  enough for a downtown block and a large venue footprint, tight enough that
 *  it cannot be satisfied from home. */
export const FENCE_METERS = 250;

/** How a check-in was established, in increasing cost to fake:
 *  - `self_reported`: a tap. Costs nothing and proves nothing.
 *  - `nearby`: the device was inside the fence. Costs a trip, or a spoofed GPS.
 *  - `verified`: a code scanned at the door. Costs standing there.
 *  Only the last two are evidence a venue can be shown. */
export type CheckInProof = 'self_reported' | 'nearby' | 'verified';

const EARTH_RADIUS_METERS = 6_371_000;

export function distanceMeters(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(deltaLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a))));
}

export type ProofResult = { proof: CheckInProof; distanceMeters: number | null };

/** A check-in with no coordinate is not a failed check-in, it is a weaker one.
 *  The distance is recorded whenever it is known, including when it is far:
 *  a rejected claim is data about the claim. */
export function resolveProof(
  device: { lat: number; lng: number } | null | undefined,
  venue: { lat: number | null; lng: number | null },
  scanned = false,
): ProofResult {
  if (scanned) return { proof: 'verified', distanceMeters: null };
  if (!device || venue.lat === null || venue.lng === null) return { proof: 'self_reported', distanceMeters: null };
  const metres = distanceMeters(device, { lat: venue.lat, lng: venue.lng });
  return { proof: metres <= FENCE_METERS ? 'nearby' : 'self_reported', distanceMeters: metres };
}

/** Points are the reason to fake a check-in, so they are paid only for the
 *  ones that cost something to obtain. An unproven tap still records — it is
 *  the member's own history — it just does not pay. */
export function pointsFor(proof: CheckInProof): number {
  return proof === 'self_reported' ? 0 : 10;
}

/** Crowd level is what a venue is shown and what a member plans against, so
 *  an unproven tap must not move it. This is the same rule as points, applied
 *  to the data instead of the reward. */
export function movesCrowdLevel(proof: CheckInProof): boolean {
  return proof !== 'self_reported';
}
