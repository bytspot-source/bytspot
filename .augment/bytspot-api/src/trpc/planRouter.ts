import { createHash, randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { serializableTransaction, serializableTransactionWithRetry } from '../lib/transactions';
import { membershipTierRank, meetsRequiredMembershipTier } from '../lib/membershipTier';
import { coffeeToBookableSnapshot, partyToBookableSnapshot, type BookableSnapshot } from '../services/bookableProjection';
import { rankPrimePath } from '../services/primePath';
import { candidatesFromPlan, candidatesFromDiscovery, filterDiscoverableParties, type PartyFacts, type PlanItemFacts, type DiscoverablePartyFacts } from '../services/primePathCandidates';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

/**
 * Plan — the control plane.
 *
 * A Plan is a structured representation of user intent that Bytspot
 * progressively turns into an executable real-world experience. It holds no
 * inventory and no money; it only references them.
 *
 * Three confirmations, three owners, never collapsed:
 *   - the creator confirms the Plan,
 *   - each participant confirms their own attendance,
 *   - a booking confirms inventory.
 *
 * Because nothing about a confirmed Plan costs anything, no participant quorum
 * gates it. What costs something — a hold, a payment — carries its own consent.
 */

const PROPOSED_PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PARTICIPANT_RESPONSES = ['accepted', 'maybe', 'declined'] as const;

/** A Plan is a coordination object, not a mailing list. */
const MAX_PLAN_PARTICIPANTS = 50;

/**
 * Capability is a fact about who controls fulfilment, so it is derived from the
 * room, never accepted from the caller. A room Bytspot settles is bookable; one
 * that only forwards a request is requestable; anything with no room behind it
 * is a reference the user resolves themselves.
 */
export function capabilityForAccessMode(accessMode: string): 'book' | 'request' | 'details' {
  if (accessMode === 'free-rsvp' || accessMode === 'paid-ticket') return 'book';
  if (accessMode === 'private-approval') return 'request';
  return 'details';
}

/**
 * Phase 2: the same rule generalized across supply kinds. A coffee
 * reservation is a hold ask, not a payment, so it derives to `request`.
 * Neither supply present is a reference the user resolves themselves.
 */
export function capabilityForSupply(supply: { party?: { accessMode: string } | null; reservation?: unknown }): 'book' | 'request' | 'details' {
  if (supply.party) return capabilityForAccessMode(supply.party.accessMode);
  if (supply.reservation) return 'request';
  return 'details';
}

type PlanRecord = {
  lifecycle: string;
  startsAt: Date | null;
  endsAt: Date | null;
  expiresAt: Date | null;
  needs: string[];
};
type ParticipantRecord = { status: string };
type ItemRecord = { needKind: string; status: string; capability?: string; partyId?: string | null; coffeeSpotId?: string | null; coffeeReservation?: { status: string } | null };

/**
 * Booked is derived from the supply, never taken from a stored flag alone: a
 * Plan may only claim an item is booked when the execution layer actually
 * settled the thing behind it. A details reference is never booked — the user
 * resolves it themselves. A coffee hold is booked once its reservation is
 * confirmed. An explicit stored `booked` is still honored so a future
 * settlement write (or the detach guard) has a durable terminal to point at.
 *
 * Party-backed booking derives from the guest's granted access. The settling
 * identity is the Plan creator (exactly right for a Plan of one; the reasonable
 * reading for a shared Plan, whose supply the creator attached), passed in as
 * the set of that creator's granted partyIds so this stays a pure function.
 */
export function itemIsBooked(item: ItemRecord, bookedPartyIds?: ReadonlySet<string>): boolean {
  if (item.status === 'cancelled') return false;
  if (item.coffeeSpotId) return false; // An unreserved selection guarantees nothing.
  if (item.capability === 'details') return false;
  if (item.status === 'booked') return true;
  if (item.partyId && bookedPartyIds?.has(item.partyId)) return true;
  if (item.coffeeReservation?.status === 'confirmed') return true;
  return false;
}

/** A proposed Plan that ran out of time is expired on read; there is no sweep. */
export function isProposedPlanExpired(plan: PlanRecord, now: Date): boolean {
  return plan.lifecycle === 'proposed' && plan.expiresAt !== null && now >= plan.expiresAt;
}

/**
 * Booked, active, and completed are never stored. Deriving them is what stops
 * the control plane from claiming something the execution layer never did.
 */
export function planDisplayState(plan: PlanRecord, items: ItemRecord[], now: Date, bookedPartyIds?: ReadonlySet<string>): string {
  if (plan.lifecycle === 'cancelled') return 'cancelled';
  if (plan.lifecycle === 'proposed') return isProposedPlanExpired(plan, now) ? 'expired' : 'proposed';
  // A lifecycle the database should not be able to hold is clamped to the
  // least-claiming state rather than echoed, so a bad row cannot render as
  // "booked" merely by being stored that way.
  if (plan.lifecycle !== 'confirmed') return 'proposed';

  if (plan.endsAt && now >= plan.endsAt) return 'completed';
  if (plan.startsAt && now >= plan.startsAt) return 'active';

  // A reference the user resolves themselves is not something Bytspot booked,
  // so a details item can never carry the Plan into `booked`; every other live
  // item must be booked, derived from its supply rather than a stored flag.
  const live = items.filter((item) => item.status !== 'cancelled');
  if (live.length > 0 && live.every((item) => item.capability !== 'details' && itemIsBooked(item, bookedPartyIds))) return 'booked';
  return 'confirmed';
}

/** Draft coffee references cannot fill a need; legacy attach semantics stay intact. */
export function openNeeds(plan: PlanRecord, items: ItemRecord[]): string[] {
  const filled = new Set(items.filter((item) => item.status !== 'cancelled' && (!item.coffeeSpotId || itemIsBooked(item))).map((item) => item.needKind));
  return plan.needs.filter((need) => !filled.has(need));
}

/**
 * Readiness always travels beside the Plan's state. "Confirmed" alone would
 * overstate a creator's decision; "Confirmed · 2 going · 1 pending" cannot.
 */
export function planReadiness(participants: ParticipantRecord[]) {
  const count = (status: string) => participants.filter((p) => p.status === status).length;
  return {
    going: count('accepted'),
    maybe: count('maybe'),
    pending: count('invited'),
    declined: count('declined'),
    total: participants.filter((p) => p.status !== 'removed').length,
  };
}

const planInclude = {
  participants: { orderBy: { createdAt: 'asc' } },
  // Items include the reservation summary they point at so the client can
  // render a hold countdown without a second round-trip. Only fields a
  // Plans row actually paints are selected; owner and idempotency stay
  // server-side, and the reservation summary is null for room-backed items.
  items: {
    orderBy: { createdAt: 'asc' },
    include: { coffeeReservation: { select: { holdExpiresAt: true, status: true, coffeeSpotId: true } } },
  },
} satisfies Prisma.PlanInclude;

type LoadedPlan = Prisma.PlanGetPayload<{ include: typeof planInclude }>;

/** The invite-link credential. 192 bits of randomness, url-safe for the path. */
function newJoinToken(): string {
  return randomBytes(24).toString('base64url');
}

type PartyBookingFacts = { granted: ReadonlySet<string>; deletionBlocked: ReadonlySet<string> };

/** Creator-scoped supply facts only, never guest credentials or checkout URLs.
 * Include cancelled items: stale item status cannot hide live fulfillment.
 */
async function partyBookingFacts(plans: LoadedPlan[], client: TxClient = db): Promise<PartyBookingFacts> {
  const seen = new Set<string>();
  const pairs: { partyId: string; userId: string }[] = [];
  for (const plan of plans) {
    for (const item of plan.items) {
      if (!item.partyId) continue;
      const key = `${item.partyId}:${plan.creatorUserId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ partyId: item.partyId, userId: plan.creatorUserId });
    }
  }
  const granted = new Set<string>();
  const deletionBlocked = new Set<string>();
  if (pairs.length === 0) return { granted, deletionBlocked };
  const rows = await client.partyGuest.findMany({
    where: { OR: pairs },
    select: { partyId: true, userId: true, accessGranted: true, status: true },
  });
  for (const row of rows) {
    const key = `${row.partyId}:${row.userId}`;
    if (row.accessGranted) granted.add(key);
    // Checkout-pending is the existing durable payment-in-flight marker.
    // Do not expire it here or invoke payment/release paths to resolve it.
    if (row.accessGranted || row.status === 'confirmed' || row.status === 'checkout-pending') deletionBlocked.add(key);
  }
  return { granted, deletionBlocked };
}

/** The creator's granted partyIds on this Plan — the set itemIsBooked reads. */
function bookedPartyIdsForPlan(plan: LoadedPlan, grantedKeys: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const item of plan.items) {
    if (item.partyId && grantedKeys.has(`${item.partyId}:${plan.creatorUserId}`)) ids.add(item.partyId);
  }
  return ids;
}

/** More conservative than display booked: pending holds and stale/cancelled
 * items still protect real supply. Bare references and selections do not.
 */
function planHasProtectedSupply(plan: LoadedPlan, facts: PartyBookingFacts): boolean {
  return plan.items.some((item) =>
    item.coffeeReservation?.status === 'pending'
    || item.coffeeReservation?.status === 'confirmed'
    || Boolean(item.partyId && facts.deletionBlocked.has(`${item.partyId}:${plan.creatorUserId}`))
    || itemIsBooked(item)
    || (item.status === 'held' && Boolean(item.partyId || item.coffeeReservationId)));
}

function serializePlan(plan: LoadedPlan, now: Date, viewerUserId: string,
  facts: PartyBookingFacts = { granted: new Set(), deletionBlocked: new Set() }) {
  const bookedPartyIds = bookedPartyIdsForPlan(plan, facts.granted);
  return {
    id: plan.id,
    title: plan.title,
    intent: plan.intent,
    creatorUserId: plan.creatorUserId,
    canDelete: !plan.deletedAt && plan.creatorUserId === viewerUserId && !planHasProtectedSupply(plan, facts),
    // The join link is a bearer secret, so only the creator is handed it; a
    // guest sees the Plan but cannot silently reshare a seat to it.
    joinToken: plan.creatorUserId === viewerUserId ? plan.joinToken : undefined,
    startsAt: plan.startsAt,
    endsAt: plan.endsAt,
    areaLabel: plan.areaLabel,
    partySize: plan.partySize,
    needs: plan.needs,
    lifecycle: plan.lifecycle,
    state: planDisplayState(plan, plan.items, now, bookedPartyIds),
    readiness: planReadiness(plan.participants),
    openNeeds: openNeeds(plan, plan.items),
    participants: plan.participants.map((p) => ({ userId: p.userId, role: p.role, status: p.status })),
    items: plan.items.map((item) => ({
      id: item.id,
      needKind: item.needKind,
      title: item.title,
      partyId: item.partyId,
      coffeeReservationId: item.coffeeReservationId,
      coffeeSpotId: item.coffeeSpotId ?? undefined,
      selectionKey: item.selectionKey ?? undefined,
      capability: item.capability,
      status: item.status,
      // Booked is derived, never echoed off the stored column, so the client
      // and Prime Path read the same truth the state roll-up does.
      booked: itemIsBooked(item, bookedPartyIds),
      // A room item has no reservation summary; the field is always null in
      // that case so the client can key hold-countdown rendering off it.
      reservation: item.coffeeReservation
        ? { holdExpiresAt: item.coffeeReservation.holdExpiresAt, status: item.coffeeReservation.status }
        : null,
    })),
  };
}

/** A Plan is indistinguishable from a deleted one to anyone not on it. */
const planNotFound = () => new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found.' });

/** Keep the original unique key occupied; an ambiguous create retry must not
 * return a usable deleted Plan or recreate it under a new identity.
 */
function existingPlanResult(plan: { id: string; deletedAt: Date | null }) {
  if (plan.deletedAt) throw new TRPCError({ code: 'CONFLICT', message: 'This Plan was deleted. Use a new idempotency key for a new Plan.' });
  return { id: plan.id };
}

type TxClient = Prisma.TransactionClient | typeof db;

/**
 * Removal ends access; declining does not. Someone who said no should still be
 * able to see the Plan and change their mind.
 */
async function loadPlanForParticipant(planId: string, userId: string, tx: TxClient = db): Promise<LoadedPlan> {
  const plan = await tx.plan.findUnique({ where: { id: planId }, include: planInclude });
  if (!plan || plan.deletedAt) throw planNotFound();
  const seat = plan.participants.find((p) => p.userId === userId);
  if (!seat || seat.status === 'removed') throw planNotFound();
  return plan;
}

async function loadPlanForCreator(planId: string, userId: string, tx: TxClient = db): Promise<LoadedPlan> {
  const plan = await tx.plan.findUnique({ where: { id: planId }, include: planInclude });
  if (!plan || plan.deletedAt || plan.creatorUserId !== userId) throw planNotFound();
  return plan;
}

/** The creator may only reshape a Plan that is still going somewhere. */
function assertPlanMutable(plan: LoadedPlan, now: Date) {
  if (plan.deletedAt) throw planNotFound();
  if (plan.lifecycle === 'cancelled') throw new TRPCError({ code: 'CONFLICT', message: 'This Plan was cancelled.' });
  if (isProposedPlanExpired(plan, now)) throw new TRPCError({ code: 'CONFLICT', message: 'This Plan expired.' });
}

// The single site where supply becomes a capability and a Bookable snapshot,
// shared by attach and createSolo so control derives from capability in exactly
// one place (contract §8). No supply behind it → a details reference that
// promises nothing. The caller never states the capability: it is derived.
async function resolveSupply(
  userId: string,
  input: { partyId: string | null; coffeeReservationId: string | null; title?: string },
  client: TxClient = db,
): Promise<{
  capability: 'book' | 'request' | 'details';
  title: string;
  snapshot: BookableSnapshot | null;
  partyId: string | null;
  coffeeReservationId: string | null;
  reservationCoffeeSpotId: string | null;
  attachedItem: { id: string; planId: string } | null;
}> {
  const { partyId, coffeeReservationId } = input;
  if (partyId && coffeeReservationId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'An item can carry only one supply.' });
  }

  let capability: 'book' | 'request' | 'details' = 'details';
  let title = input.title;
  let snapshot: BookableSnapshot | null = null;
  let reservationCoffeeSpotId: string | null = null;
  let attachedItem: { id: string; planId: string } | null = null;

  if (partyId) {
    const party = await client.party.findFirst({
      where: { id: partyId, status: 'published' },
      select: { id: true, title: true, accessMode: true, requiredMembershipTier: true },
    });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'That room could not be found.' });
    capability = capabilityForSupply({ party });
    // The room names itself; a caller-supplied title cannot misrepresent it.
    title = party.title;
    snapshot = partyToBookableSnapshot({ partyId: party.id, title: party.title, capability, accessMode: party.accessMode, requiredMembershipTier: party.requiredMembershipTier });
  } else if (coffeeReservationId) {
    const reservation = await client.coffeeReservation.findFirst({
      where: { id: coffeeReservationId, requestedByUserId: userId, spot: { active: true },
        OR: [{ status: 'confirmed' }, { status: 'pending', holdExpiresAt: { gt: new Date() } }] },
      select: { id: true, coffeeSpotId: true, spot: { select: { name: true } },
        planItem: { select: { id: true, planId: true } } },
    });
    // Not-yours and not-found read the same, mirroring the party rule so one
    // caller cannot enumerate another caller's reservations.
    if (!reservation) throw new TRPCError({ code: 'NOT_FOUND', message: 'That coffee reservation could not be found.' });
    reservationCoffeeSpotId = reservation.coffeeSpotId;
    attachedItem = reservation.planItem ?? null;
    capability = capabilityForSupply({ reservation });
    title = reservation.spot.name;
    snapshot = coffeeToBookableSnapshot({ coffeeReservationId: reservation.id, title: reservation.spot.name });
  }

  if (!title) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This item needs a title.' });
  return { capability, title, snapshot, partyId, coffeeReservationId, reservationCoffeeSpotId, attachedItem };
}

// The Bookable snapshot as Prisma create data — one mapping, so attach and
// createSolo cannot drift.
function bookableCreateData(snapshot: BookableSnapshot) {
  return {
    id: snapshot.id,
    sourceKind: snapshot.sourceKind,
    capability: snapshot.capability,
    provider: snapshot.provider,
    tierName: snapshot.tierName,
    priceCents: snapshot.priceCents,
    capacity: snapshot.capacity,
    membershipFloor: snapshot.membershipFloor,
    fulfillment: snapshot.fulfillment as Prisma.InputJsonValue,
  };
}

const createPlanInput = z.object({
  idempotencyKey: z.string().uuid(),
  title: z.string().trim().min(1).max(80),
  intent: z.string().trim().min(1).max(280),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  areaLabel: z.string().trim().max(80).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  partySize: z.number().int().min(1).max(200).optional(),
  needs: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});
const bookableSelectionsInput = z.array(z.object({
  sourceKind: z.enum(['coffeeSpot', 'party']),
  sourceId: z.string().trim().min(1).max(128),
}).strict()).max(12).refine(
  (selections) => new Set(selections.map((s) => `${s.sourceKind}:${s.sourceId}`)).size === selections.length,
  'An offering may be selected only once.',
);
type BookableSelection = z.infer<typeof bookableSelectionsInput>[number];
const selectionKeyFor = (selection: BookableSelection) => `${selection.sourceKind}:${selection.sourceId}`;

const BOOKABLE_CATEGORIES = ['coffee', 'events', 'nightlife', 'dining', 'wellness', 'fitness', 'automotive', 'stay', 'stall', 'green', 'shopping'] as const;
type BookableCategory = typeof BOOKABLE_CATEGORIES[number];

/** Host Studio's printer is not its category. Type refines broad costumes
 * (outdoor yoga vs fitness vs hike); untagged/unknown public rooms are events. */
export function categoryForParty(config: Prisma.JsonValue): BookableCategory {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'events';
  const type = typeof config.hostType === 'string' ? config.hostType : '';
  const category = typeof config.hostCategory === 'string' ? config.hostCategory : '';
  const types: Record<string, BookableCategory> = {
    afrobeats: 'nightlife', club: 'nightlife', lounge: 'nightlife', 'after-hours': 'nightlife',
    dinner: 'dining', brunch: 'dining', 'pop-up-table': 'dining',
    cruise: 'automotive', 'garage-meet': 'automotive', yoga: 'wellness',
    fitness: 'fitness', hike: 'green', market: 'shopping',
  };
  if (Object.prototype.hasOwnProperty.call(types, type)) return types[type];
  if ((BOOKABLE_CATEGORIES as readonly string[]).includes(category)) return category as BookableCategory;
  if (category === 'food-drink') return 'dining';
  if (category === 'cars') return 'automotive';
  if (category === 'outdoor') return 'green';
  return 'events';
}

/** Hash exactly the persisted intent, not property insertion order, generated
 * dates/ids, or an optional field's presence. Selections and needs are sets. */
function normalizedPlanPayload(input: z.infer<typeof createPlanInput>) {
  return {
    title: input.title, intent: input.intent,
    startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null,
    areaLabel: input.areaLabel ?? null, latitude: input.latitude ?? null,
    longitude: input.longitude ?? null, partySize: input.partySize ?? null,
    needs: [...new Set(input.needs)].sort(),
  };
}

/** Public inventory only. This is deliberately stricter than circle discovery:
 * no private-approval, invite-only, protected location, or circle-only rooms.
 * Reuse Prime Path's membership/audience check, and its published/open/time
 * gates. With no Plan location/date in this contract there is no bbox/overlap.
 * A missing end uses the existing party share-link six-hour expiry policy.
 */
async function publicBookableParties(client: TxClient, userId: string, now: Date, ids?: string[]) {
  const user = await client.user.findUnique({ where: { id: userId }, select: { membershipTier: true } });
  const userTier = user?.membershipTier ?? '';
  const allowedTiers = Object.keys(membershipTierRank).filter((tier) => meetsRequiredMembershipTier(userTier, tier));
  const parties = await client.party.findMany({
    where: {
      ...(ids ? { id: { in: ids } } : {}),
      status: 'published', closedAt: null, admissionPaused: false,
      accessMode: { in: ['free-rsvp', 'paid-ticket'] },
      templateId: { not: 'private-party' }, locationDisclosure: 'public',
      audienceCircleIds: { isEmpty: true },
      requiredMembershipTier: { in: allowedTiers },
      AND: [
        { OR: [{ endsAt: { gt: now } }, { endsAt: null, startsAt: { gt: new Date(now.getTime() - 6 * 60 * 60 * 1000) } }] },
        { OR: [{ shareLinkExpiresAt: null }, { shareLinkExpiresAt: { gt: now } }] },
      ],
    },
    select: {
      id: true, title: true, capacity: true, status: true, admissionPaused: true,
      closedAt: true, endsAt: true, startsAt: true, accessMode: true,
      requiredMembershipTier: true, audienceCircleIds: true,
      templateId: true, templateConfig: true, locationDisclosure: true, shareLinkExpiresAt: true,
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], take: ids ? 12 : 50,
  });
  // Defense in depth: all eligibility facts must survive the shared pure gate.
  const publicParties = parties.filter((party) =>
    party.status === 'published' && party.closedAt === null && !party.admissionPaused
    && ['free-rsvp', 'paid-ticket'].includes(party.accessMode)
    && party.templateId !== 'private-party' && party.locationDisclosure === 'public'
    && party.audienceCircleIds.length === 0
    && now < (party.endsAt ?? new Date(party.startsAt.getTime() + 6 * 60 * 60 * 1000))
    && (party.shareLinkExpiresAt === null || now < party.shareLinkExpiresAt));
  const eligibleIds = new Set(filterDiscoverableParties(publicParties.map((party) => ({ ...party, latitude: null, longitude: null })), {
    userTier, userCircleIds: new Set<string>(), attachedPartyIds: new Set<string>(),
  }).map((party) => party.id));
  return publicParties.filter((party) => eligibleIds.has(party.id));
}

/** Resolve every identity before writing anything, on the transaction client.
 * Never invoke reservation, RSVP, checkout, or payment paths here.
 */
async function resolveBookableSelections(client: TxClient, userId: string, selections: BookableSelection[], now: Date) {
  const coffeeIds = selections.filter((s) => s.sourceKind === 'coffeeSpot').map((s) => s.sourceId);
  const partyIds = selections.filter((s) => s.sourceKind === 'party').map((s) => s.sourceId);
  const [spots, parties] = await Promise.all([
    coffeeIds.length ? client.coffeeSpot.findMany({ where: { id: { in: coffeeIds }, active: true }, select: { id: true, name: true, active: true }, take: 12 }) : [],
    partyIds.length ? publicBookableParties(client, userId, now, partyIds) : [],
  ]);
  return selections.map((selection) => {
    const selectionKey = selectionKeyFor(selection);
    if (selection.sourceKind === 'coffeeSpot') {
      const spot = spots.find((s) => s.id === selection.sourceId && s.active);
      if (!spot) throw new TRPCError({ code: 'NOT_FOUND', message: 'That offering is not available.' });
      return { selectionKey, needKind: 'coffee', title: spot.name, capability: 'request' as const,
        coffeeSpotId: spot.id, partyId: null,
        snapshot: coffeeToBookableSnapshot({ coffeeSpotId: spot.id, title: spot.name }) };
    }
    const party = parties.find((p) => p.id === selection.sourceId);
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'That offering is not available.' });
    const capability = capabilityForSupply({ party });
    return { selectionKey, needKind: categoryForParty(party.templateConfig), title: party.title, capability,
      coffeeSpotId: null, partyId: party.id,
      snapshot: partyToBookableSnapshot({ partyId: party.id, title: party.title, capability, accessMode: party.accessMode, requiredMembershipTier: party.requiredMembershipTier }) };
  });
}

async function insertBookableSelections(client: TxClient, planId: string,
  supplies: Awaited<ReturnType<typeof resolveBookableSelections>>,
  existing: LoadedPlan['items'] = []) {
  const ids: string[] = [];
  for (const { snapshot, ...supply } of supplies) {
    // Include pre-picker attaches: a NULL/old selection key must not cause a
    // second item for the same party or already-linked coffee spot.
    const matches = existing.filter((item) => item.selectionKey === supply.selectionKey
      || (supply.partyId !== null && item.partyId === supply.partyId)
      || (supply.coffeeSpotId !== null && (item.coffeeSpotId === supply.coffeeSpotId
        || item.coffeeReservation?.coffeeSpotId === supply.coffeeSpotId)));
    if (matches.length > 1) throw new TRPCError({ code: 'CONFLICT', message: 'This offering has multiple existing items. Resolve them before adding it.' });
    const previous = matches[0];
    // Keep cancelled history too: a delayed retry must never revive a detach.
    if (previous) { ids.push(previous.id); continue; }
    await client.bookable.create({ data: bookableCreateData(snapshot) });
    const item = await client.planItem.create({ data: {
      planId, ...supply, bookableId: snapshot.id, status: 'available',
    } });
    ids.push(item.id);
  }
  return { ids };
}

export const planRouter = router({
  bookables: protectedProcedure
    // Accept catalog/native category strings without treating templates as stock.
    // Categories without a real supply adapter (including unknown ones) are empty.
    .input(z.object({ category: z.string() }))
    .query(async ({ ctx, input }) => {
      if (input.category === 'coffee') {
        const spots = await db.coffeeSpot.findMany({ where: { active: true },
          select: { id: true, name: true, areaLabel: true, active: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 50 });
        return { offerings: spots.filter((spot) => spot.active).map((spot) => ({ id: `coffeeSpot:${spot.id}`, sourceKind: 'coffeeSpot' as const,
          sourceId: spot.id, category: 'coffee', title: spot.name, subtitle: spot.areaLabel ?? undefined,
          capability: 'request' as const })) };
      }
      if ((BOOKABLE_CATEGORIES as readonly string[]).includes(input.category)) {
        const parties = await publicBookableParties(db, ctx.user.userId, new Date());
        // Events is the all-public-ROOM umbrella, at any hour, not a synonym
        // for nightlife. Each row still carries its actual canonical category.
        return { offerings: parties.filter((party) => input.category === 'events' || categoryForParty(party.templateConfig) === input.category)
          .map((party) => ({ id: `party:${party.id}`, sourceKind: 'party' as const,
            sourceId: party.id, category: categoryForParty(party.templateConfig), title: party.title,
            capability: capabilityForSupply({ party }) })) };
      }
      return { offerings: [] };
    }),

  createWithBookables: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'plan-create' }))
    .input(createPlanInput.extend({ bookableSelections: bookableSelectionsInput }).strict())
    .mutation(async ({ ctx, input }) => {
      if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A Plan cannot end before it starts.' });
      }
      const { bookableSelections } = input;
      const planInput = normalizedPlanPayload(input);
      const bookableCreationHash = createHash('sha256').update(JSON.stringify({
        version: 1, ...planInput,
        bookableSelections: bookableSelections.map(selectionKeyFor).sort(),
      })).digest('hex');
      return serializableTransactionWithRetry(async (tx) => {
        const existing = await tx.plan.findUnique({ where: { creatorUserId_idempotencyKey: {
          creatorUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey,
        } } });
        if (existing) {
          const result = existingPlanResult(existing);
          if (existing.bookableCreationHash !== bookableCreationHash) {
            throw new TRPCError({ code: 'CONFLICT', message: 'This idempotency key was used for a different Plan request.' });
          }
          // Legacy keys have no comparable payload: conflict rather than
          // silently discarding selections. Matching retries write nothing.
          return result;
        }
        const supplies = await resolveBookableSelections(tx, ctx.user.userId, bookableSelections, new Date());
        const plan = await tx.plan.create({ data: {
          ...planInput, idempotencyKey: input.idempotencyKey, creatorUserId: ctx.user.userId,
          bookableCreationHash, joinToken: newJoinToken(),
          expiresAt: input.startsAt ?? new Date(Date.now() + PROPOSED_PLAN_TTL_MS),
          participants: { create: { userId: ctx.user.userId, role: 'creator', status: 'accepted', respondedAt: new Date() } },
        } });
        await insertBookableSelections(tx, plan.id, supplies);
        return { id: plan.id };
      }, 'Another change to this Plan is in flight. Retry with the same idempotency key.');
    }),

  addBookables: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-add-bookables' }))
    .input(z.object({ planId: z.string().min(1), bookableSelections: bookableSelectionsInput }).strict())
    .mutation(async ({ ctx, input }) => serializableTransactionWithRetry(async (tx) => {
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId, tx);
      assertPlanMutable(plan, new Date());
      const supplies = await resolveBookableSelections(tx, ctx.user.userId, input.bookableSelections, new Date());
      return insertBookableSelections(tx, plan.id, supplies, plan.items);
    }, 'Another change to this Plan is in flight. Retry the same selections.')),

  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'plan-create' }))
    .input(createPlanInput)
    .mutation(async ({ ctx, input }) => {
      if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A Plan cannot end before it starts.' });
      }
      const key = { creatorUserId_idempotencyKey: { creatorUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } };
      const existing = await db.plan.findUnique({ where: key });
      if (existing) return existingPlanResult(existing);

      const expiresAt = input.startsAt ?? new Date(Date.now() + PROPOSED_PLAN_TTL_MS);
      try {
        const plan = await db.plan.create({
          data: {
            creatorUserId: ctx.user.userId,
            idempotencyKey: input.idempotencyKey,
            title: input.title,
            intent: input.intent,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            areaLabel: input.areaLabel ?? null,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            partySize: input.partySize ?? null,
            joinToken: newJoinToken(),
            needs: [...new Set(input.needs)],
            expiresAt,
            // The creator is on their own Plan, and is already going.
            participants: { create: { userId: ctx.user.userId, role: 'creator', status: 'accepted', respondedAt: new Date() } },
          },
        });
        return { id: plan.id };
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
        const concurrent = await db.plan.findUnique({ where: key });
        if (concurrent) return existingPlanResult(concurrent);
        throw error;
      }
    }),

  get: protectedProcedure
    .input(z.object({ planId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const plan = await loadPlanForParticipant(input.planId, ctx.user.userId);
      return serializePlan(plan, new Date(), ctx.user.userId, await partyBookingFacts([plan]));
    }),

  /**
   * Prime Path (§5): per need, the one defaulted, explained, confirmable path
   * for this Plan plus the alternates a decline auto-promotes into. Ranking is
   * per need — a nightlife room is never weighed against a coffee hold — and
   * candidates are the Plan's own attached supply, so no discovery or
   * visibility surface is invented here. Party seats are read Live (capacity
   * minus granted guests), never Typical. Rules-only; the ranker carries the
   * contract.
   */
  primePath: protectedProcedure
    .input(z.object({ planId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForParticipant(input.planId, ctx.user.userId);
      const live = plan.items.filter((item) => item.status !== 'cancelled');
      const partyIds = [...new Set(live.filter((item) => item.partyId).map((item) => item.partyId as string))];
      const [parties, occupancy] = partyIds.length === 0
        ? [[] as PartyFacts[], [] as { partyId: string; _count: { _all: number } }[]]
        : await Promise.all([
            db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, capacity: true, status: true, admissionPaused: true, closedAt: true, endsAt: true } }),
            db.partyGuest.groupBy({ by: ['partyId'], where: { partyId: { in: partyIds }, accessGranted: true }, _count: { _all: true } }),
          ]);
      const partyMap = new Map(parties.map((party) => [party.id, party]));
      const occupancyMap = new Map(occupancy.map((row) => [row.partyId, row._count._all]));
      const readiness = planReadiness(plan.participants);
      // A Plan with no stated size still has to seat the people going, so the
      // committed count is the honest floor when partySize is unset.
      const partySize = plan.partySize ?? Math.max(1, readiness.going);

      // ─── B4c: Discovery candidate pool (Option B — membership-gated) ───
      // Surface published parties the user is eligible for but hasn't attached.
      // Only when the Plan declares 'nightlife' as a need and has a location.
      const wantsNightlife = (plan.needs as string[]).includes('nightlife');
      let discoveredCandidates: import('../services/primePath').PrimePathCandidate[] = [];
      if (wantsNightlife && plan.latitude != null && plan.longitude != null) {
        const attachedPartyIds = new Set(partyIds);
        const BBOX_DELTA = 0.05; // ~3.5 mi
        const [user, userCircles, discoverableParties] = await Promise.all([
          db.user.findUnique({ where: { id: ctx.user.userId }, select: { membershipTier: true } }),
          db.socialCircleMember.findMany({ where: { userId: ctx.user.userId }, select: { circleId: true } }),
          db.party.findMany({
            where: {
              status: 'published',
              closedAt: null,
              admissionPaused: false,
              id: { notIn: [...attachedPartyIds] },
              // Bounding box from Plan location
              ...(plan.latitude != null && plan.longitude != null ? {
                arrivalVenue: {
                  lat: { gte: plan.latitude - BBOX_DELTA, lte: plan.latitude + BBOX_DELTA },
                  lng: { gte: plan.longitude - BBOX_DELTA, lte: plan.longitude + BBOX_DELTA },
                },
              } : {}),
              // Time overlap: party hasn't ended and starts within 24h of Plan
              ...(plan.startsAt ? {
                startsAt: { lte: new Date(plan.startsAt.getTime() + 24 * 60 * 60 * 1000) },
                OR: [{ endsAt: null }, { endsAt: { gte: now } }],
              } : {
                OR: [{ endsAt: null }, { endsAt: { gte: now } }],
              }),
            },
            select: {
              id: true, title: true, capacity: true, status: true, admissionPaused: true,
              closedAt: true, endsAt: true, startsAt: true, accessMode: true,
              requiredMembershipTier: true, audienceCircleIds: true,
              arrivalVenue: { select: { lat: true, lng: true } },
            },
            take: 20,
          }),
        ]);
        // Occupancy for discovered parties only — not the whole system.
        const discoveredIds = discoverableParties.map((p) => p.id);
        const discoveryOccupancy = discoveredIds.length > 0
          ? await db.partyGuest.groupBy({ by: ['partyId'], where: { partyId: { in: discoveredIds }, accessGranted: true }, _count: { _all: true } })
          : [];
        const userTier = user?.membershipTier ?? 'green';
        const userCircleIds = new Set(userCircles.map((m) => m.circleId));
        const discoveryOccMap = new Map(discoveryOccupancy.map((row) => [row.partyId, row._count._all]));
        const discoverable: DiscoverablePartyFacts[] = discoverableParties.map((p) => ({
          id: p.id, title: p.title, capacity: p.capacity, status: p.status,
          admissionPaused: p.admissionPaused, closedAt: p.closedAt, endsAt: p.endsAt,
          startsAt: p.startsAt, accessMode: p.accessMode,
          requiredMembershipTier: p.requiredMembershipTier,
          audienceCircleIds: p.audienceCircleIds,
          latitude: p.arrivalVenue?.lat ?? null,
          longitude: p.arrivalVenue?.lng ?? null,
        }));
        discoveredCandidates = candidatesFromDiscovery(discoverable, discoveryOccMap, { userTier, userCircleIds, attachedPartyIds }, now);
      }

      // Rank within each need, preserving item (createdAt) order across needs.
      const byNeed = new Map<string, PlanItemFacts[]>();
      for (const item of live) {
        const group = byNeed.get(item.needKind) ?? [];
        group.push(item as unknown as PlanItemFacts);
        byNeed.set(item.needKind, group);
      }
      const needs = [...byNeed.entries()].map(([needKind, items]) => {
        const attached = candidatesFromPlan(items, partyMap, occupancyMap, { partySize }, now);
        // B4c: merge discovered candidates into the nightlife need.
        const pool = needKind === 'nightlife' ? [...attached, ...discoveredCandidates] : attached;
        return { needKind, ...rankPrimePath(pool, { partySize, goingCount: readiness.going }) };
      });
      // If the Plan has a nightlife need but no attached nightlife items,
      // byNeed won't have an entry — surface discovered-only candidates.
      if (wantsNightlife && !byNeed.has('nightlife') && discoveredCandidates.length > 0) {
        needs.push({ needKind: 'nightlife', ...rankPrimePath(discoveredCandidates, { partySize, goingCount: readiness.going }) });
      }
      return { needs };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const plans = await db.plan.findMany({
      where: { deletedAt: null, participants: { some: { userId: ctx.user.userId, status: { not: 'removed' } } } },
      include: planInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const visible = plans.filter((plan) => !plan.deletedAt);
    const facts = await partyBookingFacts(visible);
    return { plans: visible.map((plan) => serializePlan(plan, now, ctx.user.userId, facts)) };
  }),

  /**
   * Join by link. The token is the credential the creator shared out-of-band
   * — a text they sent from their own device — so holding it is what seats you.
   * This is the one Plan write that does not start from an existing seat. You
   * join as a guest with status `invited`: you are on the Plan, but your own
   * attendance is still yours to confirm.
   */
  joinByToken: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-join' }))
    .input(z.object({ token: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      // Reading the cap and then writing against it has to say Serializable out
      // loud, exactly as invite does: concurrent joins could each pass a stale
      // cap check and push the Plan past MAX_PLAN_PARTICIPANTS.
      return serializableTransaction(async (tx) => {
        const plan = await tx.plan.findUnique({ where: { joinToken: input.token }, include: planInclude });
        // A closed or unknown link is indistinguishable from a Plan that never
        // existed — the same wall a non-participant hits everywhere else.
        if (
          !plan ||
          plan.deletedAt ||
          plan.lifecycle === 'cancelled' ||
          isProposedPlanExpired(plan, now) ||
          (plan.lifecycle === 'confirmed' && plan.endsAt && now >= plan.endsAt)
        ) {
          throw planNotFound();
        }

        // Scoped to this one Plan's creator, read on the transaction client so
        // the returned state matches the row just written.
        const granted = await partyBookingFacts([plan], tx);

        const seat = plan.participants.find((p) => p.userId === ctx.user.userId);
        if (seat) {
          // A removed guest does not get back in by reusing the link.
          if (seat.status === 'removed') throw planNotFound();
          return serializePlan(plan, now, ctx.user.userId, granted);
        }

        if (plan.participants.filter((p) => p.status !== 'removed').length >= MAX_PLAN_PARTICIPANTS) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This Plan is full.' });
        }

        try {
          await tx.planParticipant.create({
            data: { planId: plan.id, userId: ctx.user.userId, role: 'guest', status: 'invited' },
          });
        } catch (error) {
          // A concurrent join of the same user raced us; Serializable turns it
          // into a retryable conflict rather than a duplicate seat.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new TRPCError({ code: 'CONFLICT', message: 'Another change to this Plan is in flight. Try again.' });
          }
          throw error;
        }

        // The loaded snapshot plus the seat just written is the current state;
        // returning it avoids a second read of a row we already know.
        plan.participants.push({
          id: 'pending', planId: plan.id, userId: ctx.user.userId, role: 'guest',
          status: 'invited', respondedAt: null, createdAt: now, updatedAt: now,
        } as LoadedPlan['participants'][number]);
        return serializePlan(plan, now, ctx.user.userId, granted);
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  /** Soft removal only: retain all supply/history and the create key. Never
   * release a hold, cancel fulfillment, or call a payment/refund path here.
   */
  delete: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-delete' }))
    .input(z.object({ planId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => serializableTransactionWithRetry(async (tx) => {
      // Do not use the normal loader: only this endpoint may see a tombstone,
      // and only its creator may receive an idempotent success for it.
      const plan = await tx.plan.findUnique({ where: { id: input.planId }, include: planInclude });
      if (!plan || plan.creatorUserId !== ctx.user.userId) throw planNotFound();
      if (plan.deletedAt) return { deleted: true as const };
      const facts = await partyBookingFacts([plan], tx);
      if (planHasProtectedSupply(plan, facts)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This Plan has a booking or pending hold and cannot be deleted.' });
      }
      await tx.plan.update({ where: { id: plan.id }, data: { deletedAt: new Date() } });
      return { deleted: true as const };
    }, 'Another change to this Plan is in flight. Try again.')),

  /** Only the creator confirms, and only their own decision is recorded. */
  confirm: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-confirm' }))
    .input(z.object({ planId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      if (plan.lifecycle === 'confirmed') return { id: plan.id, lifecycle: plan.lifecycle };
      // Conditioned on the row still being proposed, so a cancel that lands
      // between the read and the write cannot be overwritten here.
      const confirmed = await db.plan.updateMany({
        where: { id: plan.id, deletedAt: null, lifecycle: 'proposed' },
        data: { lifecycle: 'confirmed', confirmedAt: now, expiresAt: null },
      });
      if (confirmed.count === 0) {
        const current = await db.plan.findUnique({ where: { id: plan.id }, select: { lifecycle: true, deletedAt: true } });
        if (!current || current.deletedAt) throw planNotFound();
        if (current.lifecycle === 'confirmed') return { id: plan.id, lifecycle: 'confirmed' };
        throw new TRPCError({ code: 'CONFLICT', message: 'This Plan was cancelled.' });
      }
      return { id: plan.id, lifecycle: 'confirmed' };
    }),

  /** Cancelling is terminal, and always wins a race against confirming. */
  cancel: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'plan-cancel' }))
    .input(z.object({ planId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      if (plan.lifecycle === 'cancelled') return { id: plan.id, lifecycle: plan.lifecycle };
      const cancelled = await db.plan.updateMany({
        where: { id: plan.id, deletedAt: null, lifecycle: { not: 'cancelled' } },
        data: { lifecycle: 'cancelled', cancelledAt: new Date() },
      });
      if (cancelled.count === 0) await loadPlanForCreator(plan.id, ctx.user.userId);
      return { id: plan.id, lifecycle: 'cancelled' };
    }),

  /**
   * Invite takes a userId and deliberately performs no relationship check.
   * Spot Code exists to introduce strangers, so a prior-relationship gate here
   * would reject the very handoff it is meant to enable.
   */
  invite: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-invite' }))
    .input(z.object({ planId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      if (input.userId === ctx.user.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You are already on this Plan.' });
      }
      const invitee = await db.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!invitee) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person could not be found.' });

      // Reading a limit and then writing against it has to say Serializable
      // out loud: two concurrent invites to different users would both pass a
      // stale cap check and push the Plan past MAX_PLAN_PARTICIPANTS.
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForCreator(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);

        // Re-read on the transaction client so a P2002 is a true race, not a
        // predictable outcome. An expected unique violation inside a Postgres
        // transaction aborts it and every following statement fails.
        const existing = await tx.planParticipant.findUnique({
          where: { planId_userId: { planId: fresh.id, userId: input.userId } },
          select: { status: true },
        });
        if (existing && existing.status !== 'removed') return { status: existing.status };

        if (fresh.participants.filter((p) => p.status !== 'removed').length >= MAX_PLAN_PARTICIPANTS) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This Plan is full.' });
        }

        if (existing) {
          // Reviving only removed rows keeps this from overwriting an answer
          // someone has already given.
          await tx.planParticipant.update({
            where: { planId_userId: { planId: fresh.id, userId: input.userId } },
            data: { status: 'invited', respondedAt: null },
          });
          return { status: 'invited' as const };
        }

        try {
          const created = await tx.planParticipant.create({
            data: { planId: fresh.id, userId: input.userId, role: 'guest', status: 'invited' },
          });
          return { status: created.status };
        } catch (error) {
          // A concurrent invite of the same person raced us. Let Serializable
          // do its job and surface the conflict at the transaction boundary.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new TRPCError({ code: 'CONFLICT', message: 'Another change to this Plan is in flight. Try again.' });
          }
          throw error;
        }
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  /** A participant answers only for themselves. */
  respond: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-respond' }))
    .input(z.object({ planId: z.string().min(1), response: z.enum(PARTICIPANT_RESPONSES) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForParticipant(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      // Re-read the Plan inside the transaction so a cancel that lands after
      // the initial load cannot be followed by a response on a dead Plan.
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForParticipant(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);
        const answered = await tx.planParticipant.updateMany({
          where: { planId: fresh.id, userId: ctx.user.userId, status: { not: 'removed' } },
          data: { status: input.response, respondedAt: now },
        });
        if (answered.count === 0) throw planNotFound();
        return { status: input.response };
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  remove: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-remove' }))
    .input(z.object({ planId: z.string().min(1), userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      if (input.userId === ctx.user.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cancel the Plan instead of removing yourself.' });
      }
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForCreator(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);
        const removed = await tx.planParticipant.updateMany({
          where: { planId: fresh.id, userId: input.userId, status: { not: 'removed' } },
          data: { status: 'removed', respondedAt: now },
        });
        if (removed.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'That person is not on this Plan.' });
        return { status: 'removed' as const };
      }, 'Another change to this Plan is in flight. Try again.');
    }),

  setNeeds: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-needs' }))
    .input(z.object({ planId: z.string().min(1), needs: z.array(z.string().trim().min(1).max(40)).max(12) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      const needs = [...new Set(input.needs)];
      const updated = await db.plan.updateMany({ where: { id: plan.id, deletedAt: null }, data: { needs } });
      if (updated.count === 0) throw planNotFound();
      return { needs, openNeeds: openNeeds({ ...plan, needs }, plan.items) };
    }),

  /**
   * Attaching supply. The caller never states the capability: it is derived
   * from the supply, so a Plan cannot advertise a booking Bytspot does not
   * control. Phase 2 accepts a generic `supplyRef` alongside the legacy
   * top-level `partyId`; a caller may set at most one supply. An item with
   * no supply behind it is a reference, and stays `details`.
   */
  attach: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-attach' }))
    .input(
      z.object({
        planId: z.string().min(1),
        needKind: z.string().trim().min(1).max(40),
        title: z.string().trim().min(1).max(120).optional(),
        // Legacy top-level partyId is kept for one release so unshipped iOS
        // builds do not break; a follow-up removes it. Prefer supplyRef.
        partyId: z.string().min(1).optional(),
        supplyRef: z
          .object({
            partyId: z.string().min(1).optional(),
            coffeeReservationId: z.string().min(1).optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => serializableTransactionWithRetry(async (tx) => {
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId, tx);
      assertPlanMutable(plan, new Date());
      if (input.partyId && input.supplyRef?.partyId && input.partyId !== input.supplyRef.partyId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Conflicting room references.' });
      }
      const partyId = input.supplyRef?.partyId ?? input.partyId ?? null;
      const coffeeReservationId = input.supplyRef?.coffeeReservationId ?? null;
      // Revalidate ownership, live reservation and supply on every attempt.
      const supply = await resolveSupply(ctx.user.userId, { partyId, coffeeReservationId, title: input.title }, tx);
      if (supply.attachedItem && supply.attachedItem.planId !== plan.id) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That reservation is already on another Plan.' });
      }
      const selectionKey = supply.reservationCoffeeSpotId
        ? `coffeeSpot:${supply.reservationCoffeeSpotId}` : partyId ? `party:${partyId}` : null;
      const matches = plan.items.filter((item) =>
        (coffeeReservationId !== null && item.coffeeReservationId === coffeeReservationId)
        || (partyId !== null && item.partyId === partyId)
        || (selectionKey !== null && item.selectionKey === selectionKey)
        || (supply.reservationCoffeeSpotId != null && (item.coffeeSpotId === supply.reservationCoffeeSpotId
          || item.coffeeReservation?.coffeeSpotId === supply.reservationCoffeeSpotId)));
      if (matches.length > 1) throw new TRPCError({ code: 'CONFLICT', message: 'This offering has multiple existing items.' });
      const previous = matches[0];
      if (previous) {
        // Exact retries return history unchanged, including cancelled rows.
        if ((coffeeReservationId && previous.coffeeReservationId === coffeeReservationId)
          || (partyId && previous.partyId === partyId)) {
          return { id: previous.id, capability: previous.capability, status: previous.status };
        }
        if (previous.status === 'cancelled' || previous.status === 'booked' || previous.coffeeReservationId
          || !previous.coffeeSpotId || previous.coffeeSpotId !== supply.reservationCoffeeSpotId || !supply.snapshot) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This selection can no longer be upgraded.' });
        }
        // Keep the canonical BYT handle and item identity. This is the existing
        // coffee projection acquiring fulfillment, not a second booking engine.
        let bookableId = previous.bookableId;
        if (bookableId) {
          const { id: _id, ...snapshotData } = bookableCreateData(supply.snapshot);
          await tx.bookable.update({ where: { id: bookableId }, data: { ...snapshotData, snapshotAt: new Date() } });
        } else {
          bookableId = supply.snapshot.id;
          await tx.bookable.create({ data: bookableCreateData(supply.snapshot) });
        }
        const item = await tx.planItem.update({ where: { id: previous.id }, data: {
          coffeeSpotId: null, coffeeReservationId, bookableId, selectionKey,
          title: supply.title, capability: supply.capability,
        } });
        return { id: item.id, capability: item.capability, status: item.status };
      }
      if (supply.snapshot) await tx.bookable.create({ data: bookableCreateData(supply.snapshot) });
      const item = await tx.planItem.create({ data: {
        planId: plan.id, needKind: input.needKind, title: supply.title,
        capability: supply.capability, partyId, coffeeReservationId,
        selectionKey, bookableId: supply.snapshot?.id ?? null,
      } });
      return { id: item.id, capability: item.capability, status: item.status };
    }, 'Another supply change is in flight, or this reservation is already attached. Retry the same request.')),

  /**
   * The booking spine — "every booking is a Plan of one". A lone bookable is
   * still a Plan: this creates a single-need Plan, seated by the caller, with
   * the supply already attached, in one transaction — so the rest of the system
   * (roll-up, recap, Prime Path) only ever reasons about Plans.
   *
   * It settles nothing and mints no Pass: the item stays `available` and the
   * capability is derived, never asserted. Actual settlement remains the
   * existing per-supply path (B3b flips the item to `booked` and freezes the
   * snapshot). Supply is required — a solo Plan with nothing behind it would be
   * an empty Plan, not a booking.
   */
  createSolo: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'plan-create-solo' }))
    .input(
      z.object({
        idempotencyKey: z.string().uuid(),
        needKind: z.string().trim().min(1).max(40),
        supplyRef: z.object({
          partyId: z.string().min(1).optional(),
          coffeeReservationId: z.string().min(1).optional(),
        }),
        title: z.string().trim().min(1).max(80).optional(),
        intent: z.string().trim().min(1).max(280).optional(),
        areaLabel: z.string().trim().max(80).optional(),
        partySize: z.number().int().min(1).max(200).optional(),
        startsAt: z.coerce.date().optional(),
        endsAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A Plan cannot end before it starts.' });
      }
      const key = { creatorUserId_idempotencyKey: { creatorUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } };
      const existing = await db.plan.findUnique({ where: key });
      if (existing) return existingPlanResult(existing);

      const partyId = input.supplyRef.partyId ?? null;
      const coffeeReservationId = input.supplyRef.coffeeReservationId ?? null;
      const supply = await resolveSupply(ctx.user.userId, { partyId, coffeeReservationId, title: input.title });
      if (!supply.partyId && !supply.coffeeReservationId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A solo Plan needs one supply.' });
      }

      // The supply names the Plan when the caller does not, so a solo Plan
      // cannot claim to be something other than the thing it wraps.
      const title = input.title ?? supply.title;
      const intent = input.intent ?? supply.title;
      const expiresAt = input.startsAt ?? new Date(Date.now() + PROPOSED_PLAN_TTL_MS);

      try {
        const created = await db.$transaction(async (tx) => {
          const plan = await tx.plan.create({
            data: {
              creatorUserId: ctx.user.userId,
              idempotencyKey: input.idempotencyKey,
              title,
              intent,
              startsAt: input.startsAt ?? null,
              endsAt: input.endsAt ?? null,
              areaLabel: input.areaLabel ?? null,
              latitude: null,
              longitude: null,
              partySize: input.partySize ?? null,
              joinToken: newJoinToken(),
              needs: [input.needKind],
              expiresAt,
              // The creator is on their own Plan, and is already going.
              participants: { create: { userId: ctx.user.userId, role: 'creator', status: 'accepted', respondedAt: new Date() } },
            },
          });
          if (supply.snapshot) await tx.bookable.create({ data: bookableCreateData(supply.snapshot) });
          await tx.planItem.create({
            data: {
              planId: plan.id,
              needKind: input.needKind,
              title: supply.title,
              capability: supply.capability,
              partyId: supply.partyId,
              coffeeReservationId: supply.coffeeReservationId,
              bookableId: supply.snapshot?.id ?? null,
            },
          });
          return { id: plan.id };
        });
        return created;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          // Either our own idempotency replay raced us — return that Plan — or the
          // supply is already on another Plan, the same wall attach puts up.
          const concurrent = await db.plan.findUnique({ where: key });
          if (concurrent) return existingPlanResult(concurrent);
          throw new TRPCError({ code: 'CONFLICT', message: 'That reservation is already on another Plan.' });
        }
        throw error;
      }
    }),

  /** Detach cancels the item; Plan history is never rewritten. */
  detach: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'plan-detach' }))
    .input(z.object({ planId: z.string().min(1), itemId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const plan = await loadPlanForCreator(input.planId, ctx.user.userId);
      assertPlanMutable(plan, now);
      const item = plan.items.find((candidate) => candidate.id === input.itemId);
      if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'That item is not on this Plan.' });
      return serializableTransaction(async (tx) => {
        const fresh = await loadPlanForCreator(plan.id, ctx.user.userId, tx);
        assertPlanMutable(fresh, now);
        // Re-derived on the transaction client: a supply that settled between
        // the read and the write makes the item booked, and a booking is never
        // silently stranded by a detach.
        const freshItem = fresh.items.find((candidate) => candidate.id === item.id);
        if (freshItem) {
          const facts = await partyBookingFacts([fresh], tx);
          if (itemIsBooked(freshItem, bookedPartyIdsForPlan(fresh, facts.granted))) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Cancel the booking before removing it from the Plan.' });
          }
        }
        // Conditional on the stored status too, so an explicit booking written
        // by a concurrent settlement is also never stranded.
        const cancelled = await tx.planItem.updateMany({
          where: { id: item.id, status: { not: 'booked' } },
          data: { status: 'cancelled' },
        });
        if (cancelled.count === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Cancel the booking before removing it from the Plan.' });
        }
        return { status: 'cancelled' as const };
      }, 'Another change to this Plan is in flight. Try again.');
    }),
});
