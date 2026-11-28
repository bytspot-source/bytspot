import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countPlannedArrivalSlots,
  plannedArrivalWhere,
  plannedArrivals,
  plannedArrivalsForVenues,
  type ArrivalFact,
  type ArrivalReader,
} from './plannedArrivals';

const NOW = new Date('2026-12-01T15:00:00Z');
const FROM = new Date('2026-12-04T19:00:00-05:00');
const TO = new Date('2026-12-04T21:00:00-05:00');

function livePlan(overrides: Partial<ArrivalFact['plan']> = {}): ArrivalFact['plan'] {
  return {
    lifecycle: 'confirmed',
    cancelledAt: null,
    deletedAt: null,
    startsAt: new Date('2026-12-04T23:00:00Z'),
    endsAt: new Date('2026-12-05T05:00:00Z'),
    expiresAt: null,
    ...overrides,
  };
}

function stop(overrides: Partial<ArrivalFact> = {}): ArrivalFact {
  return {
    planId: 'plan-1',
    venueId: 'venue-1',
    arrivesAt: new Date('2026-12-04T19:10:00-05:00'),
    status: 'available',
    plan: livePlan(),
    ...overrides,
  };
}

function counts(rows: ArrivalFact[], extra: Parameters<typeof countPlannedArrivalSlots>[1] = { venueId: 'venue-1', from: FROM, to: TO, now: NOW }) {
  return countPlannedArrivalSlots(rows, extra).map((slot) => [slot.slotStart.toISOString(), slot.count]);
}

test('counting per slot puts each arrival in the New York half-hour that contains it', () => {
  const rows = [
    stop({ planId: 'early', arrivesAt: new Date('2026-12-04T19:10:00-05:00') }),
    stop({ planId: 'later', arrivesAt: new Date('2026-12-04T20:40:00-05:00') }),
  ];
  assert.deepEqual(counts(rows), [
    [new Date('2026-12-04T19:00:00-05:00').toISOString(), 1],
    [new Date('2026-12-04T19:30:00-05:00').toISOString(), 0],
    [new Date('2026-12-04T20:00:00-05:00').toISOString(), 0],
    [new Date('2026-12-04T20:30:00-05:00').toISOString(), 1],
  ]);
});

test('distinct-plan dedupe counts a plan once in a slot however many of its stops land there', () => {
  const rows = [
    stop({ planId: 'same', arrivesAt: new Date('2026-12-04T19:05:00-05:00') }),
    stop({ planId: 'same', arrivesAt: new Date('2026-12-04T19:25:00-05:00') }),
    stop({ planId: 'other', arrivesAt: new Date('2026-12-04T19:15:00-05:00') }),
    // The same plan in a later slot still counts there.
    stop({ planId: 'same', arrivesAt: new Date('2026-12-04T20:00:00-05:00') }),
  ];
  assert.deepEqual(counts(rows), [
    [new Date('2026-12-04T19:00:00-05:00').toISOString(), 2],
    [new Date('2026-12-04T19:30:00-05:00').toISOString(), 0],
    [new Date('2026-12-04T20:00:00-05:00').toISOString(), 1],
    [new Date('2026-12-04T20:30:00-05:00').toISOString(), 0],
  ]);
});

test('cancelled plans and cancelled items are excluded, and so are deleted, expired, and ended plans', () => {
  const at = new Date('2026-12-04T19:10:00-05:00');
  const rows = [
    stop({ planId: 'going', arrivesAt: at }),
    stop({ planId: 'item-cancelled', arrivesAt: at, status: 'cancelled' }),
    stop({ planId: 'plan-cancelled', arrivesAt: at, plan: livePlan({ lifecycle: 'cancelled', cancelledAt: NOW }) }),
    stop({ planId: 'cancelled-at', arrivesAt: at, plan: livePlan({ cancelledAt: NOW }) }),
    stop({ planId: 'deleted', arrivesAt: at, plan: livePlan({ deletedAt: NOW }) }),
    stop({ planId: 'expired', arrivesAt: at, plan: livePlan({ lifecycle: 'proposed', expiresAt: new Date('2026-11-01T00:00:00Z'), endsAt: null, startsAt: null }) }),
    stop({ planId: 'ended', arrivesAt: at, plan: livePlan({ endsAt: new Date('2026-12-01T00:00:00Z') }) }),
    // Started, not ended: still a plan that can arrive.
    stop({ planId: 'underway', arrivesAt: at, plan: livePlan({ startsAt: new Date('2026-12-01T14:00:00Z'), endsAt: new Date('2026-12-05T04:00:00Z') }) }),
    // No stated end, and the default length after the start is already past.
    stop({ planId: 'lapsed', arrivesAt: at, plan: livePlan({ startsAt: new Date('2026-11-30T00:00:00Z'), endsAt: null }) }),
  ];
  assert.deepEqual(counts(rows)[0], [new Date('2026-12-04T19:00:00-05:00').toISOString(), 2]);
});

test('the plan asking is not counted as competition against itself', () => {
  const rows = [
    stop({ planId: 'asking', arrivesAt: new Date('2026-12-04T19:10:00-05:00') }),
    stop({ planId: 'everyone-else', arrivesAt: new Date('2026-12-04T19:20:00-05:00') }),
  ];
  assert.equal(counts(rows, { venueId: 'venue-1', from: FROM, to: TO, now: NOW, planId: 'asking' })[0][1], 1);
});

test('slot boundaries follow America/New_York, including a width UTC slots would bucket differently', () => {
  // 7:29pm stays in the 7:00 slot; 7:30pm opens the next. An arrival at the
  // end of the window is outside it. Just after midnight is the midnight slot,
  // not the previous evening (the formatter spells midnight as hour 24).
  const halfHours = countPlannedArrivalSlots([
    stop({ planId: 'before', arrivesAt: new Date('2026-12-04T19:29:59-05:00') }),
    stop({ planId: 'on', arrivesAt: new Date('2026-12-04T19:30:00-05:00') }),
    stop({ planId: 'end', arrivesAt: new Date('2026-12-04T20:00:00-05:00') }),
  ], {
    venueId: 'venue-1',
    from: new Date('2026-12-04T19:00:00-05:00'),
    to: new Date('2026-12-04T20:00:00-05:00'),
    now: NOW,
  });
  assert.deepEqual(halfHours.map((slot) => [slot.slotStart.toISOString(), slot.count]), [
    [new Date('2026-12-04T19:00:00-05:00').toISOString(), 1],
    [new Date('2026-12-04T19:30:00-05:00').toISOString(), 1],
  ]);

  const midnight = countPlannedArrivalSlots([
    stop({ arrivesAt: new Date('2026-12-05T00:10:00-05:00') }),
  ], {
    venueId: 'venue-1',
    from: new Date('2026-12-05T00:00:00-05:00'),
    to: new Date('2026-12-05T01:00:00-05:00'),
    now: NOW,
  });
  assert.equal(midnight[0].slotStart.toISOString(), new Date('2026-12-05T00:00:00-05:00').toISOString());
  assert.equal(midnight[0].count, 1);

  // 45 minutes does not divide the Eastern offset, so a UTC slot and a New
  // York slot that contain 7:20pm are different instants. Winter (EST) and
  // summer (EDT) both have to land on 6:45pm local.
  const fortyFive = (arrival: Date, from: Date, to: Date) => countPlannedArrivalSlots(
    [stop({ arrivesAt: arrival })],
    { venueId: 'venue-1', from, to, slotMinutes: 45, now: NOW },
  ).find((slot) => slot.count === 1);
  const winter = fortyFive(
    new Date('2026-12-04T19:20:00-05:00'),
    new Date('2026-12-04T18:00:00-05:00'),
    new Date('2026-12-04T21:00:00-05:00'),
  );
  assert.equal(winter?.slotStart.toISOString(), new Date('2026-12-04T18:45:00-05:00').toISOString());
  assert.notEqual(winter?.slotStart.toISOString(), new Date('2026-12-05T00:00:00Z').toISOString());
  const summer = fortyFive(
    new Date('2026-07-04T19:20:00-04:00'),
    new Date('2026-07-04T18:00:00-04:00'),
    new Date('2026-07-04T21:00:00-04:00'),
  );
  assert.equal(summer?.slotStart.toISOString(), new Date('2026-07-04T18:45:00-04:00').toISOString());

  // A window that opens mid-slot still labels the slot with its boundary.
  // An arrival before `from` is outside the window even though it shares that slot.
  const mid = counts([
    stop({ planId: 'too-early', arrivesAt: new Date('2026-12-04T19:10:00-05:00') }),
    stop({ planId: 'inside', arrivesAt: new Date('2026-12-04T19:20:00-05:00') }),
  ], {
    venueId: 'venue-1',
    from: new Date('2026-12-04T19:15:00-05:00'),
    to: new Date('2026-12-04T20:00:00-05:00'),
    now: NOW,
  });
  assert.deepEqual(mid, [
    [new Date('2026-12-04T19:00:00-05:00').toISOString(), 1],
    [new Date('2026-12-04T19:30:00-05:00').toISOString(), 0],
  ]);
});

test('missing venue or arrival is ignored', () => {
  const rows = [
    stop({ planId: 'whole', arrivesAt: new Date('2026-12-04T19:10:00-05:00') }),
    stop({ planId: 'no-venue', venueId: null }),
    stop({ planId: 'no-time', arrivesAt: null }),
    stop({ planId: 'elsewhere', venueId: 'venue-2' }),
  ];
  assert.equal(counts(rows)[0][1], 1);
});

test('batch returns one series per venue, in the order asked, including a venue with no stops', async () => {
  const rows = [
    stop({ planId: 'a', venueId: 'venue-a', arrivesAt: new Date('2026-12-04T19:10:00-05:00') }),
    stop({ planId: 'c1', venueId: 'venue-c', arrivesAt: new Date('2026-12-04T19:10:00-05:00') }),
    stop({ planId: 'c2', venueId: 'venue-c', arrivesAt: new Date('2026-12-04T19:40:00-05:00') }),
    stop({ planId: 'c2', venueId: 'venue-c', arrivesAt: new Date('2026-12-04T19:50:00-05:00') }),
  ];
  let calls = 0;
  const reader: ArrivalReader = {
    findMany: async (args) => {
      calls += 1;
      const where = args.where;
      assert.deepEqual(where.venueId, { in: calls === 1 ? ['venue-a', 'venue-b', 'venue-c'] : ['venue-a'] });
      assert.deepEqual(where.arrivesAt, { gte: FROM, lt: TO });
      assert.deepEqual(where.status, { not: 'cancelled' });
      const planId = where.plan && typeof where.plan.id === 'object' ? where.plan.id.not : undefined;
      assert.equal(planId, calls === 1 ? 'asking' : undefined);
      return rows;
    },
  };
  const batch = await plannedArrivalsForVenues({
    venueIds: ['venue-a', 'venue-b', 'venue-a', 'venue-c', ''],
    from: FROM,
    to: TO,
    now: NOW,
    planId: 'asking',
  }, reader);
  assert.equal(calls, 1, 'many venues are one read');
  assert.deepEqual(batch.map((entry) => entry.venueId), ['venue-a', 'venue-b', 'venue-c']);
  assert.equal(batch[0].slots[0].count, 1);
  assert.deepEqual(batch[1].slots.map((slot) => slot.count), [0, 0, 0, 0]);
  assert.deepEqual(batch[2].slots.map((slot) => slot.count), [1, 1, 0, 0]);

  const one = await plannedArrivals({ venueId: 'venue-a', from: FROM, to: TO, now: NOW }, reader);
  assert.equal(one[0].count, 1);
  assert.equal(one[0].slotStart.toISOString(), new Date('2026-12-04T19:00:00-05:00').toISOString());
});

test('the indexed read excludes cancelled, ended, and expired plans and the plan asking', () => {
  const now = NOW;
  const where = plannedArrivalWhere({ venueIds: ['venue-1'], from: FROM, to: TO, planId: 'asking', now });
  assert.deepEqual(where.venueId, { in: ['venue-1'] });
  assert.deepEqual(where.arrivesAt, { gte: FROM, lt: TO });
  assert.deepEqual(where.status, { not: 'cancelled' });
  assert.equal(where.plan?.deletedAt, null);
  assert.equal(where.plan?.cancelledAt, null);
  assert.deepEqual(where.plan?.lifecycle, { not: 'cancelled' });
  assert.deepEqual(where.plan?.id, { not: 'asking' });
  const endedBefore = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  assert.deepEqual(where.plan?.AND, [
    { OR: [{ lifecycle: { not: 'proposed' } }, { expiresAt: null }, { expiresAt: { gt: now } }] },
    {
      OR: [
        { lifecycle: { not: 'confirmed' } },
        { endsAt: { gt: now } },
        { AND: [{ endsAt: null }, { OR: [{ startsAt: null }, { startsAt: { gt: endedBefore } }] }] },
      ],
    },
  ]);
});
