import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertBackfillAllowed,
  backfillPlanStops,
  planStopPatch,
  stampForPlanItem,
  type PlanStopRow,
  type PlanStopStore,
} from './planStops';

const at = (iso: string) => new Date(iso);

function row(overrides: Partial<PlanStopRow> = {}): PlanStopRow {
  return {
    id: 'item-1',
    venueId: null,
    arrivesAt: null,
    placeId: null,
    guestBookedFor: null,
    party: null,
    offer: null,
    ...overrides,
  };
}

test('a stamp takes the offer, then the party, then the place and the guest booking, and never invents the rest', () => {
  const offerAt = at('2026-12-04T20:00:00Z');
  const partyAt = at('2026-12-04T23:00:00Z');
  const guestAt = at('2026-12-04T23:30:00Z');
  assert.deepEqual(stampForPlanItem({
    offerStartsAt: offerAt,
    offerMenuVenueId: 'venue-menu',
    partyStartsAt: partyAt,
    partyArrivalVenueId: 'venue-party',
    placeVenueId: 'venue-place',
    guestBookedFor: guestAt,
  }), { venueId: 'venue-menu', arrivesAt: offerAt });
  assert.deepEqual(stampForPlanItem({
    partyStartsAt: partyAt,
    partyArrivalVenueId: 'venue-party',
    guestBookedFor: guestAt,
  }), { venueId: 'venue-party', arrivesAt: partyAt });
  assert.deepEqual(stampForPlanItem({
    placeVenueId: 'venue-place',
    guestBookedFor: guestAt,
  }), { venueId: 'venue-place', arrivesAt: guestAt });
  // A party with no arrival venue still has a start. A place with no guest
  // time still has a venue. Coffee, and a hold, state neither.
  assert.deepEqual(stampForPlanItem({ partyStartsAt: partyAt }), { venueId: null, arrivesAt: partyAt });
  assert.deepEqual(stampForPlanItem({ placeVenueId: 'venue-place' }), { venueId: 'venue-place', arrivesAt: null });
  assert.deepEqual(stampForPlanItem({}), { venueId: null, arrivesAt: null });
  assert.deepEqual(stampForPlanItem({ offerMenuVenueId: '', partyArrivalVenueId: 'venue-party' }), { venueId: 'venue-party', arrivesAt: null });
});

test('a patch fills only what is still missing, and leaves a coffee stop alone', () => {
  const partyAt = at('2026-12-04T23:00:00Z');
  assert.deepEqual(planStopPatch(row({
    party: { startsAt: partyAt, arrivalVenueId: 'venue-party' },
  }), null), { venueId: 'venue-party', arrivesAt: partyAt });
  assert.deepEqual(planStopPatch(row({
    offer: { startsAt: partyAt, location: { menuVenueId: null } },
  }), null), { arrivesAt: partyAt });
  assert.deepEqual(planStopPatch(row({
    placeId: 'ChIJ_found',
    guestBookedFor: partyAt,
  }), 'venue-place'), { venueId: 'venue-place', arrivesAt: partyAt });
  assert.equal(planStopPatch(row({ placeId: 'ChIJ_unknown' }), null), null);
  assert.equal(planStopPatch(row(), null), null, 'coffee and bare references derive nothing');
  // Already stamped. A different party venue must not overwrite it.
  assert.deepEqual(planStopPatch(row({
    venueId: 'kept',
    party: { startsAt: partyAt, arrivalVenueId: 'other' },
  }), 'venue-place'), { arrivesAt: partyAt });
  assert.equal(planStopPatch(row({
    venueId: 'kept',
    arrivesAt: partyAt,
    party: { startsAt: at('2026-12-05T01:00:00Z'), arrivalVenueId: 'other' },
  }), null), null);
});

test('backfill writes the derived stop once and a dry run writes nothing', async () => {
  const partyAt = at('2026-12-04T23:00:00Z');
  const rows = [
    row({ id: 'party', party: { startsAt: partyAt, arrivalVenueId: 'venue-party' } }),
    row({ id: 'place', placeId: 'ChIJ_found', guestBookedFor: partyAt }),
    row({ id: 'coffee' }),
  ];
  const writes: { id: string; data: { venueId?: string; arrivesAt?: Date } }[] = [];
  const store: PlanStopStore = {
    listIncomplete: async (cursor) => (cursor ? [] : rows),
    venuesForPlaceIds: async (placeIds) => {
      assert.deepEqual(placeIds, ['ChIJ_found']);
      return [{ id: 'venue-place', googlePlaceId: 'ChIJ_found' }];
    },
    write: async (id, data) => { writes.push({ id, data }); },
  };
  const report = await backfillPlanStops(store, { batchSize: 10 });
  assert.deepEqual(report, { examined: 3, updated: 2, venueFilled: 2, arrivalFilled: 2, underived: 1 });
  assert.deepEqual(writes.map((write) => write.id), ['party', 'place']);
  assert.equal(writes[1].data.venueId, 'venue-place');

  writes.length = 0;
  const dry = await backfillPlanStops(store, { dryRun: true, batchSize: 10 });
  assert.equal(dry.updated, 2);
  assert.deepEqual(writes, []);
});

test('the backfill refuses production and never echoes a database URL', () => {
  const secret = 'super-secret-password';
  const url = `postgresql://user:${secret}@dpg-example.render.com/bytspot`;
  assert.doesNotThrow(() => assertBackfillAllowed({
    BYTSPOT_BACKFILL_PLAN_STOPS: '1',
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:local@localhost/bytspot',
  }));
  for (const env of [
    { NODE_ENV: 'development', DATABASE_URL: 'postgresql://user:local@localhost/bytspot' },
    { BYTSPOT_BACKFILL_PLAN_STOPS: '1', NODE_ENV: 'production', DATABASE_URL: 'postgresql://user:local@localhost/bytspot' },
    { BYTSPOT_BACKFILL_PLAN_STOPS: '1', NODE_ENV: 'development', RENDER: 'true', DATABASE_URL: 'postgresql://user:local@localhost/bytspot' },
    { BYTSPOT_BACKFILL_PLAN_STOPS: '1', NODE_ENV: 'development', DATABASE_URL: url },
  ]) {
    assert.throws(() => assertBackfillAllowed(env), (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      assert.equal(message.includes(secret), false);
      assert.equal(message.includes('postgresql://'), false);
      return true;
    });
  }
});
