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

/** One visit pays once. Long enough that an evening at one venue is a single
 *  visit however many times the member taps, short enough that a genuine
 *  return the next night is a new one. */
export const VISIT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Check-in is a nudge, not an income. The ceiling is what stops walking a
 *  block of venues from becoming a job, and it is per member per day. */
export const DAILY_POINT_CEILING = 50;

/** A points day is the member's day, not the server's. The container runs on
 *  UTC, so an unqualified midnight lands at 8pm Atlanta — inside the busiest
 *  check-in window, handing a Friday night two allowances. Pinned to one zone
 *  while the members are in one metro; it becomes a per-member field the day
 *  that stops being true. */
export const POINTS_TIME_ZONE = 'America/New_York';

/** A night that runs past midnight is still one night, so the day turns over
 *  at 4am local rather than at 12. This is the same reason the ceiling exists:
 *  the boundary must not fall where people are still out. */
export const DAY_TURNOVER_HOUR = 4;

/** The instant the member's current points day began. */
export function startOfPointsDay(now: Date, timeZone = POINTS_TIME_ZONE): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce<Record<string, number>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});

  // formatToParts gives the wall clock in the zone; the difference between
  // that and the instant is the offset, DST included, with no table to keep.
  const wallClock = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const offsetMs = wallClock - Math.floor(now.getTime() / 1000) * 1000;

  let boundary = Date.UTC(parts.year, parts.month - 1, parts.day, DAY_TURNOVER_HOUR) - offsetMs;
  // Before turnover, the member is still in yesterday's night.
  if (boundary > now.getTime()) boundary -= 24 * 60 * 60 * 1000;
  return new Date(boundary);
}

/** Why a check-in paid what it paid. The member is told this, so it has to be
 *  a reason rather than a silent zero. */
export type PayoutReason = 'paid' | 'unproven' | 'same_visit' | 'daily_ceiling';

export type Payout = { points: number; reason: PayoutReason };

/** The full award decision in one place, so the rules cannot disagree with
 *  each other across call sites.
 *
 *  Order matters and is deliberate: proof first, because an unproven tap was
 *  never going to pay; then the visit, because the second tap of one evening
 *  is not a second visit; then the ceiling, which is the only one that can
 *  refuse a member who did everything right. */
export function resolvePayout(input: {
  proof: CheckInProof;
  lastPaidVisitAt: Date | null | undefined;
  pointsEarnedToday: number;
  now?: Date;
}): Payout {
  const base = pointsFor(input.proof);
  if (base === 0) return { points: 0, reason: 'unproven' };

  const now = input.now ?? new Date();
  if (input.lastPaidVisitAt && now.getTime() - input.lastPaidVisitAt.getTime() < VISIT_COOLDOWN_MS) {
    return { points: 0, reason: 'same_visit' };
  }

  const remaining = DAILY_POINT_CEILING - input.pointsEarnedToday;
  if (remaining <= 0) return { points: 0, reason: 'daily_ceiling' };

  // A partial award beats a silent refusal at the boundary: the member gets
  // what is left of the day rather than nothing for being 5 points over.
  return { points: Math.min(base, remaining), reason: 'paid' };
}

/** How busy a venue is, from how many different people were there — not from
 *  how many times a tap was pressed. One member cannot report a room as
 *  packed, which is the same rule as the fence applied to the crowd number
 *  instead of the reward. */
export function crowdLevelForVisitors(distinctVisitors: number): number {
  if (distinctVisitors >= 8) return 4;
  if (distinctVisitors >= 4) return 3;
  if (distinctVisitors >= 2) return 2;
  return 1;
}

/** Crowd level is what a venue is shown and what a member plans against, so
 *  an unproven tap must not move it. This is the same rule as points, applied
 *  to the data instead of the reward. */
export function movesCrowdLevel(proof: CheckInProof): boolean {
  return proof !== 'self_reported';
}
