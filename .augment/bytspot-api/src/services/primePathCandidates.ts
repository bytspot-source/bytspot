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
import { sessionPriceFloors, type SessionPriceFloor } from './partySessions';
import { db } from '../lib/db';
import { bestTimeToGo, formatAtlantaClock, formatAtlantaIso, type BestTimeLiveReading } from './bestTimeToGo';
import { typicalWaitMins } from './typicalOccupancy';
import type { PrimePathBestTime, PrimePathCandidate } from './primePath';

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
  /** When the guest would arrive. Absent → the best-time signal stays neutral. */
  startsAt?: Date | null;
  /** Day-part category when known (bar, coffee, …). Need kind is the fallback. */
  category?: string | null;
  /** A crowd row for the arrival venue. Freshness is checked; a stale row is ignored. */
  live?: BestTimeLiveReading | null;
  arrivalVenueId?: string | null;
}

/** Plan window plus the drive the guest already knows. Category is the need's day-part. */
export interface PrimePathTiming {
  window: { startsAt: Date; endsAt: Date };
  category?: string | null;
  driveMinutes?: number | null;
}

/**
 * Bookable need → day-part curve. An unknown need stays null so the ranker
 * does not invent a midday hum for a helicopter or a stay.
 */
export function dayPartForNeed(need: string | null | undefined): string | null {
  switch ((need ?? '').trim().toLowerCase()) {
    case 'nightlife':
    case 'drinks':
    case 'bar':
    case 'club':
      return 'bar';
    case 'dining':
    case 'restaurant':
      return 'restaurant';
    case 'coffee':
      return 'coffee';
    case 'fitness':
    case 'wellness':
      return 'fitness';
    case 'green':
    case 'park':
      return 'park';
    case 'shopping':
    case 'market':
      return 'market';
    default:
      return null;
  }
}

function knownDrive(value: number | null | undefined): number | null {
  if (value == null || !Number.isInteger(value) || value < 0 || value > 180) return null;
  return value;
}

function hourKey(iso: string): string {
  return iso.slice(0, 13);
}

/**
 * Typical level and wait at the arrival inside the plan window, from
 * bestTimeToGo. A known drive pushes the arrival to now + drive when that is
 * later than the stated start. A fresh live reading replaces the typical
 * level only when that arrival is in the current Atlanta hour. Anything
 * missing, or an arrival outside the window, is null (neutral).
 */
export function bestTimeForPrimePath(input: {
  category: string | null | undefined;
  slug: string;
  arrivesAt: Date | null | undefined;
  window: { startsAt: Date; endsAt: Date } | null | undefined;
  driveMinutes?: number | null;
  live?: BestTimeLiveReading | null;
  now?: Date;
}): PrimePathBestTime | null {
  const category = input.category?.trim();
  const arrivesAt = input.arrivesAt ? new Date(input.arrivesAt) : null;
  const window = input.window;
  if (!category || !arrivesAt || Number.isNaN(arrivesAt.getTime()) || !window) return null;
  if (Number.isNaN(window.startsAt.getTime()) || Number.isNaN(window.endsAt.getTime()) || !(window.startsAt < window.endsAt)) return null;
  const now = input.now ?? new Date();
  const drive = knownDrive(input.driveMinutes);
  const earliest = drive === null ? arrivesAt : new Date(now.getTime() + drive * 60_000);
  const at = earliest > arrivesAt ? earliest : arrivesAt;
  if (at < window.startsAt || at >= window.endsAt) return null;
  const estimate = bestTimeToGo({
    venue: { category, slug: input.slug },
    window,
    driveMinutes: drive,
    live: input.live ?? null,
    now,
    slotMinutes: 30,
  });
  const target = at.getTime();
  const slot = [...estimate.slots]
    .sort((a, b) => new Date(a.arrivalAt).getTime() - new Date(b.arrivalAt).getTime())
    .reduce<{ arrivalAt: string; level: number; label: string; waitMins: number } | null>((chosen, next) => (
      new Date(next.arrivalAt).getTime() <= target ? next : chosen
    ), null);
  if (!slot) return null;
  const currentHour = estimate.rightNow && hourKey(formatAtlantaIso(at)) === hourKey(formatAtlantaIso(now));
  if (currentHour && estimate.rightNow) {
    return {
      level: estimate.rightNow.level,
      waitMins: typicalWaitMins(estimate.rightNow.level),
      label: estimate.rightNow.label,
      source: 'live',
      reason: estimate.rightNow.line,
    };
  }
  return {
    level: slot.level,
    waitMins: slot.waitMins,
    label: slot.label,
    source: 'typical',
    reason: `Typically ${slot.label.toLowerCase()} around ${formatAtlantaClock(new Date(slot.arrivalAt))} (estimate)`,
  };
}

function withBestTime(
  candidate: PrimePathCandidate,
  arrivesAt: Date | null | undefined,
  timing: PrimePathTiming | null | undefined,
  live: BestTimeLiveReading | null | undefined,
  now: Date,
  category?: string | null,
): PrimePathCandidate {
  if (!timing) return { ...candidate, bestTime: null };
  return {
    ...candidate,
    bestTime: bestTimeForPrimePath({
      category: category ?? timing.category ?? null,
      slug: candidate.id,
      arrivesAt,
      window: timing.window,
      driveMinutes: candidate.travelMinutes ?? timing.driveMinutes ?? null,
      live: live ?? null,
      now,
    }),
  };
}

const NEUTRAL = { travelMinutes: null, reliability: 0, continuationValue: 0, startLabel: null } as const;

/**
 * A party candidate carries Live seats — capacity minus granted guests — and is
 * confirmable only while the room is genuinely open: published, not closed, not
 * paused, still within its window, with room left. A missing party (deleted out
 * from under the item) is simply not confirmable.
 */
function partyCandidate(item: PlanItemFacts, party: PartyFacts | undefined, granted: number, now: Date, timing?: PrimePathTiming | null): PrimePathCandidate {
  const seats = party ? Math.max(0, party.capacity - granted) : 0;
  const open = !!party
    && party.status === 'published'
    && party.closedAt === null
    && !party.admissionPaused
    && (party.endsAt === null || now < party.endsAt);
  const base: PrimePathCandidate = {
    id: item.id,
    label: item.title,
    capability: item.capability ?? 'details',
    ownInventory: true,
    seats,
    minParty: 1,
    confirmableNow: open && seats > 0,
    ...NEUTRAL,
  };
  return withBestTime(base, party?.startsAt ?? null, timing, party?.live, now, party?.category ?? timing?.category);
}

/**
 * A coffee hold is a request, not a seat allocation, so it does not assert
 * per-guest capacity — it covers the party's ask and is confirmable while the
 * hold is live (not expired, not withdrawn). partySize decides seats so the
 * ranker's confirmability filter passes on the hold's own terms.
 */
function coffeeCandidate(item: PlanItemFacts, partySize: number, now: Date, timing?: PrimePathTiming | null): PrimePathCandidate {
  const reservation = item.coffeeReservation;
  const live = !!reservation
    && reservation.status !== 'expired'
    && reservation.status !== 'cancelled'
    && (reservation.holdExpiresAt === null || now < reservation.holdExpiresAt);
  const base: PrimePathCandidate = {
    id: item.id,
    label: item.title,
    capability: item.capability ?? 'request',
    ownInventory: true,
    seats: partySize,
    minParty: 1,
    confirmableNow: live,
    ...NEUTRAL,
  };
  // A hold has no arrival hour, so the signal stays neutral rather than scoring "now".
  return withBestTime(base, null, timing, null, now);
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
  timing?: PrimePathTiming | null,
): PrimePathCandidate[] {
  const candidates: PrimePathCandidate[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    if (item.partyId) {
      candidates.push(partyCandidate(item, parties.get(item.partyId), occupancy.get(item.partyId) ?? 0, now, timing));
    } else if (item.coffeeReservationId) {
      candidates.push(coffeeCandidate(item, ctx.partySize, now, timing));
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
  templateId: string;
  locationDisclosure: string;
  shareLinkExpiresAt: Date | null;
  /** Host opt-in for an approval door. Absent reads as not opted in. */
  showOnDiscover?: boolean;
}

/** Access modes a stranger may be shown. Anything else is a door that needs
 * a person, so the party is not offered to someone who has not been let in. */
const DISCOVERABLE_ACCESS_MODES = ['free-rsvp', 'paid-ticket'];

/** The one door a host may opt onto Discover with its location withheld. */
export const APPROVAL_ACCESS_MODE = 'private-approval';

export type DiscoverDoor = 'open' | 'approval';

export function discoverDoor(party: { accessMode: string }): DiscoverDoor {
  return party.accessMode === APPROVAL_ACCESS_MODE ? 'approval' : 'open';
}

/**
 * Opt-in for surfaces that withhold location. Only `events.nearby` passes it:
 * every other caller places a party on a map or into a Plan, and an approval
 * door's location must never reach either.
 */
export interface DiscoveryScope {
  approvalOptIn?: boolean;
}

const OPEN_DOOR_WHERE = {
  accessMode: { in: DISCOVERABLE_ACCESS_MODES },
  templateId: { not: 'private-party' },
  locationDisclosure: 'public',
};

/**
 * The database half of the same rule `filterDiscoverableParties` enforces.
 * Both exist on purpose: this keeps the scan small, the pure gate is what
 * actually decides, and a caller that forgets one is still refused by the
 * other. Audience circles are deliberately absent — callers differ on whether
 * a circle-scoped party is in scope, and that is the one honest difference
 * between them. A party hidden by reports, hosted by a suspended account, or
 * hosted by someone the caller blocked or was blocked by is never offered.
 */
export function discoverablePartyWhere(now: Date, excludedHostIds: readonly string[] = [], scope: DiscoveryScope = {}) {
  const base = {
    status: 'published',
    moderationHiddenAt: null,
    host: { suspendedAt: null },
    ...(excludedHostIds.length > 0 ? { hostUserId: { notIn: [...excludedHostIds] } } : {}),
    closedAt: null,
    admissionPaused: false,
  };
  const window = [
    { OR: [{ endsAt: { gt: now } }, { endsAt: null, startsAt: { gt: new Date(now.getTime() - 6 * 60 * 60 * 1000) } }] },
    { OR: [{ shareLinkExpiresAt: null }, { shareLinkExpiresAt: { gt: now } }] },
  ];
  if (!scope.approvalOptIn) return { ...base, ...OPEN_DOOR_WHERE, AND: window };
  return {
    ...base,
    AND: [...window, { OR: [OPEN_DOOR_WHERE, { accessMode: APPROVAL_ACCESS_MODE, showOnDiscover: true }] }],
  };
}

// Preserve the exported helper for existing callers, with no second mapping.
export { capabilityForAccessMode } from './bookableProjection';

/** Project a discovered party into a PrimePathCandidate. */
export function discoveredPartyCandidate(
  party: DiscoverablePartyFacts,
  granted: number,
  now: Date,
  timing?: PrimePathTiming | null,
): PrimePathCandidate {
  const seats = Math.max(0, party.capacity - granted);
  const open = party.status === 'published'
    && party.closedAt === null
    && !party.admissionPaused
    && (party.endsAt === null || now < party.endsAt);
  const base: PrimePathCandidate = {
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
  return withBestTime(base, party.startsAt, timing, null, now, timing?.category);
}

/**
 * Pure filter: keep only parties the user is eligible to discover.
 * Excludes parties already attached to the Plan (by partyId).
 *
 * Discovery shows a party to someone who was never invited, so every reason a
 * party is not for strangers is checked here rather than trusted to the query
 * that loaded it. A host's private party must not become findable because one
 * call site forgot a clause.
 */
export function filterDiscoverableParties<T extends DiscoverablePartyFacts>(
  parties: T[],
  ctx: { userTier: string; userCircleIds: ReadonlySet<string>; attachedPartyIds: ReadonlySet<string>; now: Date } & DiscoveryScope,
): T[] {
  return parties.filter((p) => {
    if (ctx.attachedPartyIds.has(p.id)) return false;
    if (p.status !== 'published' || p.closedAt !== null || p.admissionPaused) return false;
    // A private template, a door that needs approval, or an address withheld
    // until approval all mean the host chose who comes. Discovery is not an
    // invitation, so none of them are offered — unless the host opted an
    // approval door in and the caller withholds its location.
    const optedInApproval = ctx.approvalOptIn === true
      && p.accessMode === APPROVAL_ACCESS_MODE
      && p.showOnDiscover === true;
    if (!optedInApproval) {
      if (p.templateId === 'private-party') return false;
      if (p.locationDisclosure !== 'public') return false;
      if (!DISCOVERABLE_ACCESS_MODES.includes(p.accessMode)) return false;
    }
    // An expired share link is indistinguishable from a deleted party, and
    // discovery must not be the one surface that reveals it.
    if (p.shareLinkExpiresAt !== null && ctx.now >= p.shareLinkExpiresAt) return false;
    if (ctx.now >= (p.endsAt ?? new Date(p.startsAt.getTime() + 6 * 60 * 60 * 1000))) return false;
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
  timing?: PrimePathTiming | null,
): PrimePathCandidate[] {
  return filterDiscoverableParties(parties, { ...ctx, now })
    .map((p) => discoveredPartyCandidate(p, occupancy.get(p.id) ?? 0, now, timing));
}

/**
 * The cheapest session still takeable in each of these Parties, with the terms
 * that decide how it may be worded.
 *
 * Both card projections ask this one question so a Party cannot advertise one
 * floor in Discover and another on the Prime Path.
 *
 * Settled units decide takeability here rather than live claims: a list of
 * cards cannot afford a per-session hold count, and the claim is about price
 * rather than availability. The detail view stays the authority on whether a
 * particular session is still open.
 */
export async function partySessionPriceFloors(
  partyIds: string[],
  now: Date,
): Promise<Map<string, SessionPriceFloor>> {
  if (partyIds.length === 0) return new Map();
  const sessions = await db.partySession.findMany({
    where: {
      partyId: { in: partyIds },
      withdrawnAt: null,
      startsAt: { gt: now },
      priceCents: { gt: 0 },
      committed: { lt: db.partySession.fields.quantity },
    },
    select: { partyId: true, priceCents: true, bottleTerms: true },
  });
  return sessionPriceFloors(sessions.map((session) => ({
    partyId: session.partyId,
    priceCents: session.priceCents,
    bottleTerms: session.bottleTerms === 'minimum' ? 'minimum' : 'included',
  })));
}
