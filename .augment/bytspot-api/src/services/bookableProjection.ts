// Server-side Bookable projection (Phase 3, B2). Mirrors the client engine in
// bytspot-beta/src/utils/bookableProjection.ts and the contract §4/§8: it turns
// attached supply into the persisted `Bookable` snapshot a Plan item points to.
//
// `control` is never stored — it is derived from `capability` here — so the
// projection can never contradict the trust gate. Upstream ids live only in
// `fulfillment`, never in the canonical `BYT-…` id.

import { randomUUID } from 'node:crypto';

// The server derives a three-state capability from supply (see
// planRouter.capabilityForSupply). `redirect` is a client-only state until
// table / deep-link supply exists server-side, matching the native fold.
export type BookableCapability = 'book' | 'request' | 'details';
export type BookableControl = 'local' | 'vendor';
export type BookableSourceKind = 'party_ticket' | 'coffee';

/** One rule for catalog, attachments, and Prime Path. Free RSVP can grant
 * access directly; private approval needs the host. Unknown modes fail closed.
 * Capability describes the available action, never an existing booking. */
export function capabilityForAccessMode(accessMode: string): BookableCapability {
  if (accessMode === 'free-rsvp' || accessMode === 'paid-ticket') return 'book';
  if (accessMode === 'private-approval') return 'request';
  return 'details';
}

const CONTROL_BY_CAPABILITY: Record<BookableCapability, BookableControl> = {
  book: 'vendor',
  request: 'vendor',
  details: 'local',
};

export function controlFromCapability(capability: BookableCapability): BookableControl {
  return CONTROL_BY_CAPABILITY[capability];
}

// A persisted snapshot is unique per attach, so the id is minted per row rather
// than hashed from a stable key (the client projection is stateless and hashes
// for determinism). Both keep upstream ids out of the id — they live only in
// `fulfillment` — so a BYT- handle never leaks the source it snapshots.
export function bookableId(sourceKind: BookableSourceKind): string {
  return `BYT-${sourceKind}-${randomUUID()}`;
}

export interface BookableSnapshot {
  id: string;
  sourceKind: BookableSourceKind;
  capability: BookableCapability;
  provider: string | null;
  tierName: string;
  priceCents: number;
  capacity: number;
  membershipFloor: string | null;
  fulfillment: Record<string, unknown>;
}

// A Plan item attaches to a room, not a specific ticket tier, so the snapshot is
// room-level: tier pricing is read live at booking time (B3), not frozen here.
export function partyToBookableSnapshot(input: {
  partyId: string;
  title: string;
  capability: BookableCapability;
  accessMode: string;
  requiredMembershipTier: string | null;
}): BookableSnapshot {
  return {
    id: bookableId('party_ticket'),
    sourceKind: 'party_ticket',
    capability: input.capability,
    provider: null,
    tierName: input.title,
    priceCents: 0,
    capacity: 0,
    membershipFloor: input.requiredMembershipTier,
    fulfillment: { partyId: input.partyId, accessMode: input.accessMode },
  };
}

// Coffee supports a hold-ask, never a payment. A spot selection has no
// reservation and guarantees no capacity; both use the same projection.
export function coffeeToBookableSnapshot(input: { title: string } & (
  | { coffeeReservationId: string; coffeeSpotId?: never }
  | { coffeeSpotId: string; coffeeReservationId?: never }
)): BookableSnapshot {
  return {
    id: bookableId('coffee'),
    sourceKind: 'coffee',
    capability: 'request',
    provider: null,
    tierName: input.title,
    priceCents: 0,
    capacity: input.coffeeReservationId ? 1 : 0,
    membershipFloor: null,
    fulfillment: input.coffeeReservationId
      ? { coffeeReservationId: input.coffeeReservationId }
      : { coffeeSpotId: input.coffeeSpotId },
  };
}
