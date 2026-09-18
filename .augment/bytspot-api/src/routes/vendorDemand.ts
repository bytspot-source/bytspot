import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { requireCapability, requireVendorSeat } from '../middleware/vendorAuth';
import { deriveSlots, type Commitment, type DerivedSlot } from '../vendor/availability';
import {
  anyMatch,
  canRunDemandOperation,
  isActionable,
  slotsForDemand,
  stateAfterOperation,
  type EvaluableDemand,
  type EvaluableSupply,
} from '../vendor/demand';

const router = Router();

/** Two seats answered at once, or the slot went between reading and writing. */
class DemandMoved extends Error {}
class NoCapacity extends Error {}

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
type SupplyDetail = Map<string, { title: string; locationId: string; location: LocationDto }>;

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
async function supplyFor(sellerId: string, now: Date): Promise<SupplySnapshot> {
  const windows = await db.vendorAvailabilityWindow.findMany({
    where: { sellerId, active: true, location: { state: 'ACTIVE' } },
    include: { location: true },
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
      state: { in: ['OPEN', 'MATCHED'] },
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
async function snapshot(sellerId: string, locations: Parameters<typeof demandFor>[0], now: Date) {
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
        priceCents: item.priceCents,
        maxGuests: item.maxGuests,
        slots: item.slots.map(slotDto),
      };
    }),
  };
}

router.get('/vendor/demand', requireVendorSeat, async (req, res) => {
  try {
    const now = new Date();
    res.status(200).json(await snapshot(req.vendor!.seller.id, req.vendor!.locations, now));
  } catch (err) {
    captureError(err, { route: 'vendor/demand:get' });
    res.status(500).json({ error: 'Internal error' });
  }
});

const respondBody = z.object({
  operation: z.enum(['OFFER', 'WITHDRAW_OFFER', 'DECLINE']),
  bookableId: z.string().trim().min(1).max(100),
});

router.post('/vendor/demand/:id/respond', requireVendorSeat, requireCapability('SELL'), async (req, res) => {
  const parsed = respondBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid response', blockers: ['Choose what to offer first'] });
    return;
  }

  const demandId = String(req.params.id ?? '');
  if (!demandId) {
    res.status(404).json({ error: 'No such request' });
    return;
  }

  const sellerId = req.vendor!.seller.id;
  const now = new Date();

  try {
    const demand = await db.demand.findUnique({ where: { id: demandId } });
    // Indistinguishable from a demand that never existed, so a seller cannot
    // probe ids to learn what other people are asking for.
    if (!demand || demand.expiresAt <= now) {
      res.status(404).json({ error: 'No such request' });
      return;
    }

    // The window must be this seller's. Answering from someone else's capacity
    // is the one mistake this endpoint must never make.
    const window = await db.vendorAvailabilityWindow.findFirst({
      where: { id: parsed.data.bookableId, sellerId, active: true },
      include: { location: true },
    });
    if (!window) {
      res.status(404).json({ error: 'No such offering' });
      return;
    }

    if (!canRunDemandOperation(parsed.data.operation, demand.state, req.vendor!.capabilities)) {
      res.status(409).json({
        error: 'Not available',
        blockers: ['That request has already moved on'],
      });
      return;
    }

    const nextState = stateAfterOperation(parsed.data.operation);
    if (!nextState) {
      res.status(400).json({ error: 'Invalid response' });
      return;
    }

    await db.$transaction(async (tx) => {
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
          sellerId,
          kind: parsed.data.operation === 'OFFER' ? 'OFFERED' : parsed.data.operation === 'DECLINE' ? 'DECLINED' : 'WITHDRAWN',
          detail: { windowId: window.id, operation: parsed.data.operation },
        },
      });

      if (parsed.data.operation === 'OFFER') {
        const slots = deriveSlots({
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
        });
        const evaluated = {
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
        };
        const supply: EvaluableSupply = {
          windowId: window.id,
          domain: window.domain,
          latitude: window.location.lat,
          longitude: window.location.lng,
          serviceRadiusMiles: window.location.radiusMiles,
          priceCents: window.priceCents,
          maxGuests: window.maxGuests,
          slots,
        };
        // Re-derived rather than taken from the request: the console decided
        // what to offer from a feed that may be minutes old, and the slot it
        // chose may have gone since.
        const usable = slotsForDemand(evaluated, supply, now);
        if (!usable.length) throw new NoCapacity();

        await tx.offer.create({
          data: {
            demandId: demand.id,
            sellerId,
            locationId: window.locationId,
            windowId: window.id,
            skuTemplateId: window.skuTemplateId,
            startsAt: usable[0].startsAt,
            durationMins: window.slotMinutes,
            priceCents: window.priceCents,
            capacity: window.maxGuests,
            createdBySeatId: req.vendor!.seat.id,
            // A hold is a promise with a deadline. The contract's expiry is the
            // longest a guest is made to wait for an answer.
            holdExpiresAt: new Date(now.getTime() + 120 * 60_000),
          },
        });
      }

      if (parsed.data.operation === 'WITHDRAW_OFFER') {
        await tx.offer.updateMany({
          where: { demandId: demand.id, sellerId, state: 'OFFERED' },
          data: { state: 'WITHDRAWN' },
        });
      }
    });

    res.status(200).json(await snapshot(sellerId, req.vendor!.locations, new Date()));
  } catch (err) {
    if (err instanceof DemandMoved) {
      res.status(409).json({ error: 'Not available', blockers: ['Someone else answered that first'] });
      return;
    }
    if (err instanceof NoCapacity) {
      res.status(409).json({ error: 'No capacity', blockers: ['That slot has gone since you looked'] });
      return;
    }
    captureError(err, { route: 'vendor/demand:respond' });
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
