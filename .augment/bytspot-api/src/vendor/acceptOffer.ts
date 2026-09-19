import { db } from '../lib/db';
import { bookableCreateData, offerToBookableSnapshot } from '../services/bookableProjection';

/**
 * Taking an offer.
 *
 * This is the first moment in the rail where something becomes true for both
 * sides at once: the guest has a table, and the seller has one fewer to sell.
 * Everything before it is conversation.
 *
 * Accepting is therefore where capacity is actually committed. Offering does
 * not commit it — a seller may answer ten requests from one window hoping one
 * lands, which is honest selling, not overbooking. The overbooking would
 * happen here, if two guests accepted the same slot at the same instant, so
 * the commitment is written under the database's own uniqueness guarantee
 * rather than under anything this process believes.
 */

export class OfferGone extends Error {
  constructor() {
    super('That offer is no longer available.');
  }
}

export class OfferExpired extends Error {
  constructor() {
    super('That offer expired. Ask again and someone else may answer.');
  }
}

export class SlotTaken extends Error {
  constructor() {
    super('Someone took the last one while you were deciding.');
  }
}

export class NotYours extends Error {
  constructor() {
    super('That offer was not made to you.');
  }
}

export interface AcceptedOffer {
  offerId: string;
  demandId: string;
  where: string;
  startsAt: string;
  durationMins: number;
  priceCents: number;
  terms?: string;
}

/**
 * Accept one offer, decline the rest, and commit the slot.
 *
 * Ordering matters: the slot is committed before the offer is marked accepted.
 * A guest told "someone took the last one" when nothing was taken is merely
 * annoyed; a guest holding a confirmation for a table that does not exist is a
 * problem for a real business on a real evening.
 */
export async function acceptOffer(input: { offerId: string; userId: string; now?: Date }): Promise<AcceptedOffer> {
  const now = input.now ?? new Date();

  const offer = await db.offer.findUnique({
    where: { id: input.offerId },
    include: { demand: true, location: true, window: true },
  });
  if (!offer) throw new OfferGone();
  // Not-yours and not-found are the same answer on purpose: a stranger probing
  // offer ids learns nothing about which ones exist.
  if (offer.demand.raisedByUserId !== input.userId) throw new NotYours();
  if (offer.state !== 'OFFERED') throw new OfferGone();
  if (offer.holdExpiresAt <= now) throw new OfferExpired();
  if (offer.demand.state === 'BOOKED') throw new OfferGone();
  if (offer.demand.state === 'WITHDRAWN' || offer.demand.state === 'EXPIRED') throw new OfferGone();

  return db.$transaction(async (tx) => {
    // A hand-asserted offer answers from no standing window, so there is no
    // slot to commit. The seller took the booking on themselves.
    if (offer.windowId) {
      const window = offer.window;
      if (!window) throw new OfferGone();

      if (window.quantity < 1) throw new SlotTaken();

      // Increment first, create only if there is nothing to increment. The
      // reverse order reads better but cannot tell "no row yet" apart from
      // "row already at capacity", and an upsert cannot either: a row sitting
      // at exactly the count a fresh create would write is indistinguishable
      // from the create having happened, so one booking silently overwrites
      // another.
      const taken = await tx.vendorSlotCommitment.updateMany({
        where: {
          windowId: offer.windowId,
          startsAt: offer.startsAt,
          committed: { lt: window.quantity },
          blocked: false,
          closed: false,
        },
        data: { committed: { increment: 1 } },
      });

      if (taken.count === 0) {
        const existing = await tx.vendorSlotCommitment.findUnique({
          where: { windowId_startsAt: { windowId: offer.windowId, startsAt: offer.startsAt } },
          select: { id: true },
        });
        // A row that exists but did not increment is full, blocked or closed.
        if (existing) throw new SlotTaken();
        // No row yet: this is the slot's first booking. If a concurrent accept
        // creates it first, the unique index on (window_id, starts_at) rejects
        // this one and the whole accept rolls back rather than double-selling.
        await tx.vendorSlotCommitment.create({
          data: { windowId: offer.windowId, startsAt: offer.startsAt, committed: 1 },
        });
      }
    }

    // What the guest agreed to, frozen. The database refuses an accepted offer
    // without one, which is the right rule: a booking the guest cannot be shown
    // later is not a booking. The seller may change the window tomorrow; this
    // does not change with it.
    const snapshot = offerToBookableSnapshot({
      offerId: offer.id,
      where: offer.location.label,
      priceCents: offer.priceCents,
      capacity: offer.capacity,
      startsAt: offer.startsAt,
      durationMins: offer.durationMins,
    });
    await tx.bookable.create({ data: { ...bookableCreateData(snapshot), snapshotAt: now } });

    // Guarded on OFFERED: a hold that expired or was withdrawn between the read
    // and here must not be accepted, and the slot commit above rolls back with
    // the transaction.
    const claimed = await tx.offer.updateMany({
      where: { id: offer.id, state: 'OFFERED', holdExpiresAt: { gt: now } },
      data: { state: 'ACCEPTED', bookableId: snapshot.id },
    });
    if (claimed.count === 0) throw new OfferGone();

    // The guest chose. Every other seller who answered is released now rather
    // than left holding a maybe until their hold lapses.
    await tx.offer.updateMany({
      where: { demandId: offer.demandId, state: 'OFFERED', id: { not: offer.id } },
      data: { state: 'DECLINED' },
    });

    await tx.demand.update({
      where: { id: offer.demandId },
      data: { state: 'BOOKED' },
    });

    await tx.demandEvent.create({
      data: {
        demandId: offer.demandId,
        sellerId: offer.sellerId,
        kind: 'ACCEPTED',
        detail: { offerId: offer.id, windowId: offer.windowId, priceCents: offer.priceCents },
      },
    });

    return {
      offerId: offer.id,
      demandId: offer.demandId,
      where: offer.location.label,
      startsAt: offer.startsAt.toISOString(),
      durationMins: offer.durationMins,
      priceCents: offer.priceCents,
      terms: offer.terms ?? undefined,
    };
  });
}
