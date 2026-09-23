import { z } from 'zod';
import { db } from '../lib/db';

/**
 * The one intent that exists today.
 *
 * A seller declaring it is saying: send me asks, I will answer with an offer,
 * and I will honour it if the guest takes it. Every part of that sentence is
 * built — demand, offers, holds, acceptance, capacity. `book`, `order` and
 * `redirect` are not words a seller can say yet, because the platform could
 * not hold them to any of them.
 */
export const ASK_INTENT = 'request';
import { notifyOfferArrived } from '../services/offerNotifications';
import { deriveSlots, type Commitment, type DerivedSlot } from './availability';
import {
  anyMatch,
  canRunDemandOperation,
  isActionable,
  slotsForDemand,
  stateAfterOperation,
  type EvaluableDemand,
  type EvaluableSupply,
} from './demand';
import { coverUrlFor } from './media';

/** Two seats answered at once, or the slot went between reading and writing. */
export class DemandMoved extends Error {}
export class NoCapacity extends Error {}

/**
 * The demand a business can answer, and the capacity it would answer from.
 *
 * Both halves come from one read because the console matches them against each
 * other. Demand fetched at one moment and supply at another would produce
 * offers against slots that had already sold, and the vendor would be shown
 * something they cannot honour.
 *
 * The feed is scoped by geography and liveness only. It deliberately does not
 * pre-filter by category, party size, budget or capacity: the console reports
 * *why* a demand went unanswered, and a demand filtered out server-side has no
 * reason attached. Demand nobody could answer is the half that tells a vendor
 * what to change.
 */

/** Rough degrees for a mile, used only to bound the query before real distance. */
const MILES_PER_DEGREE_LAT = 69;

/** Window id to the seller-facing detail the console renders. */
type SupplyDetail = Map<string, { title: string; locationId: string; location: LocationDto; coverUrl?: string }>;

interface SupplySnapshot {
  supply: EvaluableSupply[];
  detail: SupplyDetail;
}

interface LocationDto {
  id: string;
  label: string;
  kind: string;
  state: string;
  address?: string;
  lat: number;
  lng: number;
  radiusMiles?: number;
  timezone?: string;
}

function locationDto(location: {
  id: string;
  label: string;
  kind: string;
  state: string;
  address: string | null;
  lat: number;
  lng: number;
  radiusMiles: number | null;
  timezone: string | null;
}): LocationDto {
  return {
    id: location.id,
    label: location.label,
    kind: location.kind,
    state: location.state,
    address: location.address ?? undefined,
    lat: location.lat,
    lng: location.lng,
    radiusMiles: location.radiusMiles ?? undefined,
    timezone: location.timezone ?? undefined,
  };
}

function slotDto(slot: DerivedSlot) {
  return {
    id: slot.id,
    startsAt: slot.startsAt.toISOString(),
    startMins: slot.startMins,
    weekday: slot.weekday,
    quantity: slot.quantity,
    committed: slot.committed,
    blocked: slot.blocked,
    closed: slot.closed,
    state: slot.state,
    minimumQuantity: slot.minimumQuantity,
  };
}

/**
 * A seller's live windows, turned into the supply the rules read.
 *
 * Only ACTIVE locations contribute. A paused place still has windows, and
 * answering from one would promise a guest a door that is shut.
 */
export async function supplyFor(sellerId: string, now: Date): Promise<SupplySnapshot> {
  const windows = await db.vendorAvailabilityWindow.findMany({
    // Intent is filtered here, not checked at the point of offering, so a
    // window the seller has not offered for this never reaches the feed and
    // cannot be answered from by any later path.
    where: { sellerId, active: true, intent: ASK_INTENT, location: { state: 'ACTIVE' } },
    include: { location: true, media: { where: { kind: 'cover' }, select: { id: true, kind: true } } },
  });

  const detail: SupplyDetail = new Map();
  const supply: EvaluableSupply[] = [];
  if (!windows.length) return { supply, detail };

  const commitments = await db.vendorSlotCommitment.findMany({
    where: { windowId: { in: windows.map((window) => window.id) }, startsAt: { gte: now } },
  });
  const byWindow = new Map<string, Commitment[]>();
  for (const row of commitments) {
    const list = byWindow.get(row.windowId) ?? [];
    list.push({ startsAt: row.startsAt, committed: row.committed, blocked: row.blocked, closed: row.closed });
    byWindow.set(row.windowId, list);
  }

  for (const window of windows) {
    supply.push({
      windowId: window.id,
      domain: window.domain,
      latitude: window.location.lat,
      longitude: window.location.lng,
      // Only a travelling vendor's radius widens reach; a fixed place's does not.
      serviceRadiusMiles: window.location.radiusMiles,
      priceCents: window.priceCents,
      maxGuests: window.maxGuests,
      slots: deriveSlots({
        window: {
          id: window.id,
          domain: window.domain,
          weekdays: window.weekdays,
          openMins: window.openMins,
          closeMins: window.closeMins,
          quantity: window.quantity,
          slotKind: window.slotKind,
          slotMinutes: window.slotMinutes,
          leadTimeMins: window.leadTimeMins,
          horizonDays: window.horizonDays,
        },
        timeZone: window.location.timezone,
        commitments: byWindow.get(window.id),
        now,
      }),
    });
    detail.set(window.id, {
      title: window.skuTemplateId,
      locationId: window.locationId,
      location: locationDto(window.location),
      coverUrl: coverUrlFor(window.media),
    });
  }

  return { supply, detail };
}

/**
 * Live demand whose geography could plausibly reach this seller.
 *
 * Bounded by a box rather than exact distance so the database can use the
 * index; the location rule then applies real distance. The box is widened by
 * the furthest a travelling vendor will go, or the demand would be dropped
 * before the rule that would have accepted it ran.
 */
async function demandFor(
  locations: { lat: number; lng: number; radiusMiles: number | null; state: string }[],
  now: Date,
): Promise<EvaluableDemand[]> {
  const active = locations.filter((location) => location.state === 'ACTIVE');
  if (!active.length) return [];

  const reach = active.map((location) => {
    // A demand carries its own radius, which may exceed the seller's. The
    // contract's maximum is the widest either side can ask for.
    const miles = Math.max(location.radiusMiles ?? 0, 50);
    return {
      minLat: location.lat - miles / MILES_PER_DEGREE_LAT,
      maxLat: location.lat + miles / MILES_PER_DEGREE_LAT,
      minLng: location.lng - miles / (MILES_PER_DEGREE_LAT * Math.max(0.01, Math.cos((location.lat * Math.PI) / 180))),
      maxLng: location.lng + miles / (MILES_PER_DEGREE_LAT * Math.max(0.01, Math.cos((location.lat * Math.PI) / 180))),
    };
  });

  const rows = await db.demand.findMany({
    where: {
      // OFFERED is included even though the contract calls only OPEN and
      // MATCHED actionable. A seller who has answered must keep seeing the
      // request, or withdrawing becomes unreachable: the console can only act
      // on what the feed shows it.
      state: { in: ['OPEN', 'MATCHED', 'OFFERED'] },
      expiresAt: { gt: now },
      OR: reach.map((box) => ({
        latitude: { gte: box.minLat, lte: box.maxLat },
        longitude: { gte: box.minLng, lte: box.maxLng },
      })),
    },
    orderBy: { raisedAt: 'desc' },
    take: 200,
  });

  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    state: row.state,
    partySize: row.partySize,
    earliest: row.earliest,
    latest: row.latest,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusMiles: row.radiusMiles,
    budgetCents: row.budgetCents,
  }));
}

function demandDto(demand: EvaluableDemand, raisedAt: Date, note: string | null) {
  return {
    id: demand.id,
    category: demand.category,
    state: demand.state,
    partySize: demand.partySize,
    earliest: demand.earliest.toISOString(),
    latest: demand.latest.toISOString(),
    lat: demand.latitude,
    lng: demand.longitude,
    radiusMiles: demand.radiusMiles,
    budgetCents: demand.budgetCents ?? undefined,
    note: note ?? undefined,
    raisedAt: raisedAt.toISOString(),
  };
}

/**
 * Assembles the snapshot, and records the fact that this seller saw it.
 *
 * A demand that at least one window can answer becomes MATCHED, because that is
 * what MATCHED means and because the contract will not let a seller offer
 * against anything else. Nothing here suppresses a demand a seller already
 * declined: every matching seller keeps seeing it, and the log remembers who
 * passed.
 */
export async function buildDemandSnapshot(sellerId: string, locations: Parameters<typeof demandFor>[0], now: Date) {
  const { supply, detail } = await supplyFor(sellerId, now);
  const demands = await demandFor(locations, now);

  const matchedIds: string[] = [];
  for (const demand of demands) {
    if (demand.state === 'OPEN' && isActionable(demand.state) && anyMatch(demand, supply, now)) {
      matchedIds.push(demand.id);
      demand.state = 'MATCHED';
    }
  }

  if (matchedIds.length) {
    await db.$transaction([
      db.demand.updateMany({ where: { id: { in: matchedIds }, state: 'OPEN' }, data: { state: 'MATCHED' } }),
      db.demandEvent.createMany({
        data: matchedIds.map((demandId) => ({ demandId, sellerId, kind: 'BROADCAST' })),
      }),
    ]);
  }

  const raised = new Map(
    (await db.demand.findMany({ where: { id: { in: demands.map((item) => item.id) } }, select: { id: true, raisedAt: true, note: true } })).map(
      (row) => [row.id, row],
    ),
  );

  return {
    demand: demands.map((item) => demandDto(item, raised.get(item.id)?.raisedAt ?? now, raised.get(item.id)?.note ?? null)),
    supply: supply.map((item) => {
      const info = detail.get(item.windowId);
      return {
        // The console calls a seller's own offering a bookable; here that is
        // the window it derives from.
        bookableId: item.windowId,
        title: info?.title ?? item.windowId,
        domain: item.domain,
        location: info?.location,
        coverUrl: info?.coverUrl,
        priceCents: item.priceCents,
        maxGuests: item.maxGuests,
        slots: item.slots.map(slotDto),
      };
    }),
  };
}


/** The window named does not belong to this seller, or the demand has gone. */
export class NotFound extends Error {
  constructor(readonly what: 'request' | 'offering') {
    super(what);
  }
}

export const respondInput = z.object({
  operation: z.enum(['OFFER', 'WITHDRAW_OFFER', 'DECLINE']),
  bookableId: z.string().trim().min(1).max(100),
});

export interface RespondingSeat {
  sellerId: string;
  seatId: string;
  capabilities: string[];
  locations: Parameters<typeof demandFor>[0];
}

/**
 * A seller's answer to a request.
 *
 * Kept out of the HTTP layer so it can be run against a real database. The
 * route below is a thin translation of these outcomes into status codes.
 */
export async function respondToDemand(
  seat: RespondingSeat,
  demandId: string,
  input: z.infer<typeof respondInput>,
  now: Date = new Date(),
) {
  const demand = await db.demand.findUnique({ where: { id: demandId } });
  // Indistinguishable from a demand that never existed, so a seller cannot
  // probe ids to learn what other people are asking for.
  if (!demand || demand.expiresAt <= now) throw new NotFound('request');

  // The window must be this seller's. Answering from someone else's capacity
  // is the one mistake this endpoint must never make.
  const window = await db.vendorAvailabilityWindow.findFirst({
    where: { id: input.bookableId, sellerId: seat.sellerId, active: true, intent: ASK_INTENT },
    include: { location: true },
  });
  // Not-found rather than a refusal: a window that does not answer asks is not
  // an offering as far as this rail is concerned. The seat named an id the feed
  // would never have shown it.
  if (!window) throw new NotFound('offering');

  if (!canRunDemandOperation(input.operation, demand.state, seat.capabilities)) throw new DemandMoved();

  const nextState = stateAfterOperation(input.operation);
  if (!nextState) throw new DemandMoved();

  const offeredId = await db.$transaction(async (tx) => {
    let offered: string | null = null;
    // Guarded on the state we read: two seats answering at once must not both
    // win, and the loser is told the request moved rather than silently
    // overwriting the winner.
    const moved = await tx.demand.updateMany({
      where: { id: demand.id, state: demand.state },
      data: { state: nextState },
    });
    if (moved.count === 0) throw new DemandMoved();

    await tx.demandEvent.create({
      data: {
        demandId: demand.id,
        sellerId: seat.sellerId,
        kind: input.operation === 'OFFER' ? 'OFFERED' : input.operation === 'DECLINE' ? 'DECLINED' : 'WITHDRAWN',
        detail: { windowId: window.id, operation: input.operation },
      },
    });

    if (input.operation === 'OFFER') {
      const supply: EvaluableSupply = {
        windowId: window.id,
        domain: window.domain,
        latitude: window.location.lat,
        longitude: window.location.lng,
        serviceRadiusMiles: window.location.radiusMiles,
        priceCents: window.priceCents,
        maxGuests: window.maxGuests,
        slots: deriveSlots({
          window: {
            id: window.id,
            domain: window.domain,
            weekdays: window.weekdays,
            openMins: window.openMins,
            closeMins: window.closeMins,
            quantity: window.quantity,
            slotKind: window.slotKind,
            slotMinutes: window.slotMinutes,
            leadTimeMins: window.leadTimeMins,
            horizonDays: window.horizonDays,
          },
          timeZone: window.location.timezone,
          now,
        }),
      };
      // Re-derived rather than taken from the request: the console decided what
      // to offer from a feed that may be minutes old, and the slot it chose may
      // have gone since.
      const usable = slotsForDemand(
        {
          id: demand.id,
          category: demand.category,
          state: demand.state,
          partySize: demand.partySize,
          earliest: demand.earliest,
          latest: demand.latest,
          latitude: demand.latitude,
          longitude: demand.longitude,
          radiusMiles: demand.radiusMiles,
          budgetCents: demand.budgetCents,
        },
        supply,
        now,
      );
      if (!usable.length) throw new NoCapacity();

      const created = await tx.offer.create({
        data: {
          demandId: demand.id,
          sellerId: seat.sellerId,
          locationId: window.locationId,
          windowId: window.id,
          skuTemplateId: window.skuTemplateId,
          startsAt: usable[0].startsAt,
          durationMins: window.slotMinutes,
          priceCents: window.priceCents,
          capacity: window.maxGuests,
          createdBySeatId: seat.seatId,
          // A hold is a promise with a deadline.
          holdExpiresAt: new Date(now.getTime() + 120 * 60_000),
        },
      });
      offered = created.id;
    }

    if (input.operation === 'WITHDRAW_OFFER') {
      await tx.offer.updateMany({
        where: { demandId: demand.id, sellerId: seat.sellerId, state: 'OFFERED' },
        data: { state: 'WITHDRAWN' },
      });
    }

    return offered;
  });

  // After the commit, never inside it: a push is not worth holding a database
  // transaction open for, and an offer that exists must not be undone because
  // a notification failed.
  if (offeredId) await notifyOfferArrived(offeredId);

  return buildDemandSnapshot(seat.sellerId, seat.locations, new Date());
}
