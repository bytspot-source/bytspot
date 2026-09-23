import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import { serializableTransactionWithRetry } from '../lib/transactions';
import { stateAfterOperation } from './demand';
import { needKindForDemandCategory } from './planDemand';
import { bookableCreateData, offerToBookableSnapshot } from '../services/bookableProjection';
import { sequenceForAppend } from '../services/planLegs';

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

/**
 * The one demand state that can hold an acceptable offer, taken from the
 * contract rather than restated here: OFFER moves a demand to it, so an offer
 * worth accepting implies it.
 *
 * An allowlist, after review pointed out that my denylist of terminal states
 * was not the fail-closed thing I had claimed in the comment above it — a state
 * added later would have fallen through it and been accepted.
 */
const ACCEPTABLE_DEMAND_STATE = stateAfterOperation('OFFER');

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

  // Serializable, not merely atomic. This reads a Plan and then writes an
  // item against it while plans.delete reads that Plan's items and then
  // tombstones it. Postgres only detects that pair when both sides are
  // serializable, so a Read Committed accept would let a delete decide there
  // was nothing to protect and strand a table the seller had committed.
  return serializableTransactionWithRetry(async (tx) => {
    // Take the demand row first, before any capacity or offer row is touched.
    //
    // Two guests cannot accept the same demand, but two *offers* on one demand
    // can be accepted at the same instant, and without this both transactions
    // reach the sibling-decline step holding each other's offer rows. That
    // deadlocks, and Postgres picks a loser: correct in the end, but the loser
    // gets a raw database error instead of being told what happened.
    //
    // Locking here makes the ordering deliberate rather than accidental. Every
    // accept for a demand queues on one row, in one place, and the loser reads
    // a BOOKED demand and refuses cleanly.
    const [locked] = await tx.$queryRaw<{ state: string }[]>`
      SELECT "state" FROM "demands" WHERE "id" = ${offer.demandId} FOR UPDATE
    `;
    if (!locked) throw new OfferGone();
    // Re-read under the lock: the state checked before the transaction may have
    // moved while this accept was waiting its turn.
    if (locked.state !== ACCEPTABLE_DEMAND_STATE) throw new OfferGone();

    // A hand-asserted offer answers from no standing window, so there is no
    // slot to commit. The seller took the booking on themselves.
    if (offer.windowId) {
      const window = offer.window;
      if (!window) throw new OfferGone();

      if (window.quantity < 1) throw new SlotTaken();

      // Make the row exist without taking anything. Two accepts racing into an
      // empty slot both need a row before either can increment, and whoever
      // loses that insert must not be told the slot is full when it is empty:
      // ON CONFLICT DO NOTHING lets the loser continue to the increment below
      // rather than rolling the whole accept back on a unique violation.
      await tx.$executeRaw`
        INSERT INTO "vendor_slot_commitments" ("id", "window_id", "starts_at", "committed", "updated_at")
        VALUES (${randomUUID()}, ${offer.windowId}, ${offer.startsAt}, 0, NOW())
        ON CONFLICT ("window_id", "starts_at") DO NOTHING
      `;

      // The only operation that takes capacity, and the only one that decides
      // whether there was any to take. Row-level locking on the guarded update
      // is what serialises concurrent accepts; the count is never read first
      // and acted on afterwards.
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
      // Full, blocked or closed. The row certainly exists by now, so nothing
      // else can explain a miss.
      if (taken.count === 0) throw new SlotTaken();
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

    // File the table in the Plan it was asked for.
    //
    // A demand raised from Concierge has no Plan, and a Plan deleted while the
    // request was live is gone for good — in both cases the booking still
    // stands, it simply has nowhere to be filed. The demand inbox remains its
    // home, so nothing is lost by not writing an item here.
    if (offer.demand.planId) {
      const needKind = needKindForDemandCategory(offer.demand.category);
      // Serializable is what protects this read (see the transaction note
      // above): a Plan deleted between here and the insert turns into a
      // serialization failure and the retry sees the tombstone.
      const plan = await tx.plan.findFirst({
        where: { id: offer.demand.planId, deletedAt: null },
        select: { id: true, items: { select: { id: true, position: true, createdAt: true } } },
      });
      // No need kind means the category never came from a Plan need. Filing it
      // under a guessed one would put a booking in a list the guest never
      // wrote, so it stays unfiled and honest.
      if (plan && needKind) {
        // Settle anything a previous deploy left unpositioned before
        // appending, in this same transaction, so the won table cannot
        // overtake an item that was already in the Plan.
        const sequence = sequenceForAppend(plan.items);
        for (const repair of sequence.repairs) {
          await tx.planItem.update({ where: { id: repair.id }, data: { position: repair.position } });
        }
        await tx.planItem.create({
          data: {
            planId: plan.id,
            needKind,
            title: offer.location.label,
            offerId: offer.id,
            bookableId: snapshot.id,
            // Capacity is committed; this is a booking, not an intention.
            capability: 'book',
            status: 'booked',
            selectionKey: `vendorOffer:${offer.id}`,
            // A won table appends to the Plan rather than displacing anything
            // already in it.
            position: sequence.position,
          },
        });
      }
    }

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
  }, 'Another change to this booking is in flight. Try again.');
}
