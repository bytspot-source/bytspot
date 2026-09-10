// Prime Path candidate projection (Phase 5, B4b). Turns the supply a Plan
// already holds — its own attached items — into the PrimePathCandidate facts the
// rules-only ranker reads (§5). Pure: it takes loaded rows, never queries, so it
// stays testable and the wiring in planRouter owns the reads.
//
// Two honesty rules govern the mapping:
//   * capability is read straight off the item — asserted once at attach (§8.1),
//     never re-inferred here, so the card, the booking, and the ranker agree.
//   * a fact is only asserted when it is known. Party seats come from live
//     occupancy (capacity minus granted guests), never Typical; travel and
//     vendor reliability have no server data yet, so they are left neutral
//     rather than invented — the ranker treats them as ties.

import { capabilityForAccessMode, type BookableCapability } from './bookableProjection';
import { meetsRequiredMembershipTier } from '../lib/membershipTier';
import type { PrimePathCandidate } from './primePath';

export interface PlanItemFacts {
  id: string;
  title: string;
  status: string;
  capability: BookableCapability | null;
  partyId: string | null;
  coffeeReservationId: string | null;
  coffeeReservation: { status: string; holdExpiresAt: Date | null } | null;
}

export interface PartyFacts {
  id: string;
  capacity: number;
  status: string;
  admissionPaused: boolean;
  closedAt: Date | null;
  endsAt: Date | null;
}

const NEUTRAL = { travelMinutes: null, reliability: 0, continuationValue: 0, startLabel: null } as const;

/**
 * A party candidate carries Live seats — capacity minus granted guests — and is
 * confirmable only while the room is genuinely open: published, not closed, not
 * paused, still within its window, with room left. A missing party (deleted out
 * from under the item) is simply not confirmable.
 */
function partyCandidate(item: PlanItemFacts, party: PartyFacts | undefined, granted: number, now: Date): PrimePathCandidate {
  const seats = party ? Math.max(0, party.capacity - granted) : 0;
  const open = !!party
    && party.status === 'published'
    && party.closedAt === null
    && !party.admissionPaused
    && (party.endsAt === null || now < party.endsAt);
  return {
    id: item.id,
    label: item.title,
    capability: item.capability ?? 'details',
    ownInventory: true,
    seats,
    minParty: 1,
    confirmableNow: open && seats > 0,
    ...NEUTRAL,
  };
}

/**
 * A coffee hold is a request, not a seat allocation, so it does not assert
 * per-guest capacity — it covers the party's ask and is confirmable while the
 * hold is live (not expired, not withdrawn). partySize decides seats so the
 * ranker's confirmability filter passes on the hold's own terms.
 */
function coffeeCandidate(item: PlanItemFacts, partySize: number, now: Date): PrimePathCandidate {
  const reservation = item.coffeeReservation;
  const live = !!reservation
    && reservation.status !== 'expired'
    && reservation.status !== 'cancelled'
    && (reservation.holdExpiresAt === null || now < reservation.holdExpiresAt);
  return {
    id: item.id,
    label: item.title,
    capability: item.capability ?? 'request',
    ownInventory: true,
    seats: partySize,
    minParty: 1,
    confirmableNow: live,
    ...NEUTRAL,
  };
}

/**
 * Project a Plan's live items into ranker candidates. Cancelled items and pure
 * references (details, no supply behind them) produce no candidate: a reference
 * the user resolves themselves is never a Prime Path nor a promotable alternate.
 */
export function candidatesFromPlan(
  items: PlanItemFacts[],
  parties: ReadonlyMap<string, PartyFacts>,
  occupancy: ReadonlyMap<string, number>,
  ctx: { partySize: number },
  now: Date,
): PrimePathCandidate[] {
  const candidates: PrimePathCandidate[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    if (item.partyId) {
      candidates.push(partyCandidate(item, parties.get(item.partyId), occupancy.get(item.partyId) ?? 0, now));
    } else if (item.coffeeReservationId) {
      candidates.push(coffeeCandidate(item, ctx.partySize, now));
    }
    // A details/reference item asserts no supply and is intentionally skipped.
  }
  return candidates;
}

// ─── B4c: Discovery candidate pool ─────────────────────────────────────────
// Option B ruling: a published, non-closed, non-paused party is discoverable to
// any user whose membership tier meets requiredMembershipTier. If the party has
// non-empty audienceCircleIds, the user must also be a member of at least one.

export interface DiscoverablePartyFacts extends PartyFacts {
  title: string;
  accessMode: string;
  requiredMembershipTier: string;
  audienceCircleIds: string[];
  startsAt: Date;
  latitude: number | null;
  longitude: number | null;
}

// Preserve the exported helper for existing callers, with no second mapping.
export { capabilityForAccessMode } from './bookableProjection';

/** Project a discovered party into a PrimePathCandidate. */
export function discoveredPartyCandidate(
  party: DiscoverablePartyFacts,
  granted: number,
  now: Date,
): PrimePathCandidate {
  const seats = Math.max(0, party.capacity - granted);
  const open = party.status === 'published'
    && party.closedAt === null
    && !party.admissionPaused
    && (party.endsAt === null || now < party.endsAt);
  return {
    id: `discovered:${party.id}`,
    label: party.title,
    capability: capabilityForAccessMode(party.accessMode),
    ownInventory: true,
    seats,
    minParty: 1,
    confirmableNow: open && seats > 0,
    discovered: true,
    ...NEUTRAL,
  };
}

/**
 * Pure filter: keep only parties the user is eligible to discover.
 * Excludes parties already attached to the Plan (by partyId).
 */
export function filterDiscoverableParties(
  parties: DiscoverablePartyFacts[],
  ctx: { userTier: string; userCircleIds: ReadonlySet<string>; attachedPartyIds: ReadonlySet<string> },
): DiscoverablePartyFacts[] {
  return parties.filter((p) => {
    if (ctx.attachedPartyIds.has(p.id)) return false;
    if (!meetsRequiredMembershipTier(ctx.userTier, p.requiredMembershipTier)) return false;
    if (p.audienceCircleIds.length > 0 && !p.audienceCircleIds.some((c) => ctx.userCircleIds.has(c))) return false;
    return true;
  });
}

/**
 * Full discovery pipeline: filter eligible parties, project each as a
 * PrimePathCandidate with `discovered: true`.
 */
export function candidatesFromDiscovery(
  parties: DiscoverablePartyFacts[],
  occupancy: ReadonlyMap<string, number>,
  ctx: { userTier: string; userCircleIds: ReadonlySet<string>; attachedPartyIds: ReadonlySet<string> },
  now: Date,
): PrimePathCandidate[] {
  return filterDiscoverableParties(parties, ctx)
    .map((p) => discoveredPartyCandidate(p, occupancy.get(p.id) ?? 0, now));
}
