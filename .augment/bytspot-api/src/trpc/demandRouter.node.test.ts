import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';
import { DEMAND_DEFAULTS } from '../vendor/demand';

/**
 * Publishing is the one place a single guest writes into every matching
 * vendor's feed, so most of what is asserted here is what it refuses.
 */

const createCaller = createCallerFactory(appRouter);
const demand = db.demand as any;
const demandEvent = db.demandEvent as any;
const plan = db.plan as any;

const authenticated: Context = {
  user: { userId: 'guest-1', email: 'guest@bytspot.com' },
  clientRateLimitKey: 'test-demand-client',
};

function caller(overrides: Partial<Context> = {}) {
  return createCaller({ ...authenticated, ...overrides });
}

/** A request for a table in Midtown, two hours from now. */
function input(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    category: 'dining',
    partySize: 2,
    earliest: new Date(now + 2 * 60 * 60 * 1000),
    latest: new Date(now + 4 * 60 * 60 * 1000),
    latitude: 33.7866,
    longitude: -84.3833,
    ...overrides,
  };
}

let created: any[] = [];

beforeEach(() => {
  resetLocalRateLimitForTests();
  created = [];
  demand.count = async () => 0;
  demand.create = async ({ data }: any) => {
    const row = { id: `demand-${created.length + 1}`, state: 'OPEN', raisedAt: new Date(), ...data };
    created.push(row);
    return row;
  };
  demandEvent.create = async () => ({});
  plan.findFirst = async () => null;
  demand.findFirst = async () => null;
});

test('a publishable need is stored open, with the contract defaults filled in', async () => {
  const result = await caller().demand.publish(input());

  assert.equal(result.state, 'OPEN');
  assert.equal(result.category, 'dining');
  assert.equal(created.length, 1);
  // Unstated radius is the contract's, not a number chosen here.
  assert.equal(created[0].radiusMiles, DEMAND_DEFAULTS.radiusMiles);
  assert.equal(created[0].budgetCents, null);
  assert.equal(created[0].planId, null);
  assert.equal(created[0].raisedByUserId, 'guest-1');
});

test('raising a need is logged, so who asked and when survives the demand', async () => {
  let logged: any = null;
  demandEvent.create = async ({ data }: any) => {
    logged = data;
    return {};
  };
  await caller().demand.publish(input());
  assert.equal(logged.kind, 'PUBLISHED');
  assert.ok(logged.demandId);
});

test('an anonymous caller cannot write into a vendor feed', async () => {
  await assert.rejects(() => createCaller({ user: null } as Context).demand.publish(input()), { code: 'UNAUTHORIZED' });
  assert.equal(created.length, 0);
});

test('a demand never outlives the window it asks about', async () => {
  // Dinner tonight stops being a request the moment tonight is over, however
  // much of the contract's two hours is left on the clock.
  const latest = new Date(Date.now() + 20 * 60 * 1000);
  await caller().demand.publish(input({ earliest: new Date(Date.now() + 10 * 60 * 1000), latest }));
  assert.equal(created[0].expiresAt.getTime(), latest.getTime());
});

test('a long window expires on the contracts clock, not the guests', async () => {
  const latest = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await caller().demand.publish(input({ latest }));
  const expected = Date.now() + DEMAND_DEFAULTS.expiryMins * 60_000;
  assert.ok(Math.abs(created[0].expiresAt.getTime() - expected) < 5_000);
});

test('a window that ends before it starts, or in the past, is refused', async () => {
  const now = Date.now();
  await assert.rejects(
    () => caller().demand.publish(input({ earliest: new Date(now + 4 * 3600_000), latest: new Date(now + 2 * 3600_000) })),
    { code: 'BAD_REQUEST' },
  );
  await assert.rejects(
    () => caller().demand.publish(input({ earliest: new Date(now - 7200_000), latest: new Date(now - 3600_000) })),
    { code: 'BAD_REQUEST' },
  );
  assert.equal(created.length, 0);
});

test('Null Island is a failed geolocation, not a place', async () => {
  // Accepting it would publish a request no seller could ever reach, and the
  // guest would watch it expire without ever learning why.
  await assert.rejects(() => caller().demand.publish(input({ latitude: 0, longitude: 0 })), { code: 'BAD_REQUEST' });
  assert.equal(created.length, 0);
});

test('a Discover rail is not a category the rules can evaluate', async () => {
  // eat_drink carries no domains, so it could never match any seller.
  await assert.rejects(() => caller().demand.publish(input({ category: 'eat_drink' })), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().demand.publish(input({ category: 'not-a-thing' })), { code: 'BAD_REQUEST' });
  assert.equal(created.length, 0);
});

test('the contract caps party size and reach, whatever is asked for', async () => {
  await assert.rejects(() => caller().demand.publish(input({ partySize: DEMAND_DEFAULTS.maxPartySize + 1 })), {
    code: 'BAD_REQUEST',
  });
  await assert.rejects(() => caller().demand.publish(input({ partySize: 0 })), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().demand.publish(input({ radiusMiles: DEMAND_DEFAULTS.maxRadiusMiles + 1 })), {
    code: 'BAD_REQUEST',
  });
  assert.equal(created.length, 0);

  await caller().demand.publish(input({ partySize: DEMAND_DEFAULTS.maxPartySize, radiusMiles: DEMAND_DEFAULTS.maxRadiusMiles }));
  assert.equal(created.length, 1);
});

test('demand can be attached to your own Plan, and to nobody elses', async () => {
  plan.findFirst = async () => ({ id: 'plan-1' });
  await caller().demand.publish(input({ planId: 'plan-1' }));
  assert.equal(created[0].planId, 'plan-1');

  // Someone else's Plan is indistinguishable from one that does not exist.
  plan.findFirst = async () => null;
  await assert.rejects(() => caller().demand.publish(input({ planId: 'plan-2' })), { code: 'NOT_FOUND' });
  assert.equal(created.length, 1);
});

test('one person cannot flood the feed with open requests', async () => {
  demand.count = async () => 5;
  await assert.rejects(() => caller().demand.publish(input()), { code: 'CONFLICT' });
  assert.equal(created.length, 0);

  // Once one lands or expires there is room again.
  demand.count = async () => 4;
  await caller().demand.publish(input());
  assert.equal(created.length, 1);
});

test('the publish budget is per person, so a second device does not double it', async () => {
  for (let i = 0; i < 20; i += 1) await caller().demand.publish(input());
  assert.equal(created.length, 20);

  // Same user, different client key: still refused.
  await assert.rejects(() => caller({ clientRateLimitKey: 'another-device' }).demand.publish(input()), {
    code: 'TOO_MANY_REQUESTS',
  });

  // A different person is unaffected by their neighbour's spending.
  const other = createCaller({ user: { userId: 'guest-2', email: 'other@bytspot.com' }, clientRateLimitKey: 'test-demand-client' });
  await other.demand.publish(input());
  assert.equal(created.length, 21);
});

test('an empty note is stored as nothing rather than as an empty string', async () => {
  await caller().demand.publish(input({ note: '   ' }));
  assert.equal(created[0].note, null);
});

test('a guest can see what they asked for and what came back', async () => {
  const now = Date.now();
  demand.findMany = async () => [
    {
      id: 'demand-1',
      state: 'OFFERED',
      category: 'dining',
      partySize: 2,
      earliest: new Date(now + 3600_000),
      latest: new Date(now + 7200_000),
      budgetCents: null,
      note: null,
      planId: null,
      raisedAt: new Date(now),
      expiresAt: new Date(now + 7200_000),
      offers: [
        {
          id: 'offer-1',
          location: { label: 'Broni Home Taste' },
          startsAt: new Date(now + 4000_000),
          durationMins: 90,
          priceCents: 5000,
          terms: null,
          holdExpiresAt: new Date(now + 3600_000),
          payAt: 'venue',
          checkouts: [],
        },
      ],
    },
  ];

  const mine = await caller().demand.mine();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].state, 'OFFERED');
  // The place, not the business: a guest recognises where they are going.
  assert.equal(mine[0].offers[0].where, 'Broni Home Taste');
  assert.equal(mine[0].offers[0].priceCents, 5000);
  assert.equal(mine[0].offers[0].payAt, 'venue');
  assert.equal(mine[0].offers[0].payment, undefined);
});

test('an expired hold is not shown as an offer that is still standing', async () => {
  // The query itself is what excludes them, so assert the filter rather than
  // the mapping: a lapsed hold must never reach the guest as a live table.
  let where: any = null;
  demand.findMany = async (args: any) => {
    where = args.where;
    return [];
  };
  await caller().demand.mine();
  const [live, booked] = where.OR;
  assert.deepEqual(live.state.in, ['OPEN', 'MATCHED', 'OFFERED']);
  assert.ok(live.expiresAt.gt instanceof Date);

  // The second branch keeps a table the guest already holds. It must be
  // reachable only through an offer they actually accepted.
  assert.equal(booked.state, 'BOOKED');
  assert.equal(booked.offers.some.state, 'ACCEPTED');
  assert.ok(booked.offers.some.startsAt.gt instanceof Date);
});

test('withdrawing releases the sellers who were holding capacity', async () => {
  demand.findFirst = async () => ({ id: 'demand-1', state: 'MATCHED' });
  let offersWithdrawn = false;
  let logged: any = null;
  (db as any).$transaction = async (fn: any) =>
    fn({
      demand: { updateMany: async () => ({ count: 1 }) },
      offer: {
        updateMany: async ({ where, data }: any) => {
          offersWithdrawn = where.state === 'OFFERED' && data.state === 'WITHDRAWN';
          return { count: 1 };
        },
      },
      demandEvent: { create: async ({ data }: any) => ((logged = data), {}) },
    });

  const result = await caller().demand.withdraw({ demandId: 'demand-1' });
  assert.equal(result.state, 'WITHDRAWN');
  assert.equal(offersWithdrawn, true);
  assert.equal(logged.kind, 'WITHDRAWN');
});

test('someone elses request is indistinguishable from one that does not exist', async () => {
  demand.findFirst = async () => null;
  await assert.rejects(() => caller().demand.withdraw({ demandId: 'demand-9' }), { code: 'NOT_FOUND' });
});

test('a finished request cannot be withdrawn, and a race cannot undo a booking', async () => {
  demand.findFirst = async () => ({ id: 'demand-1', state: 'BOOKED' });
  await assert.rejects(() => caller().demand.withdraw({ demandId: 'demand-1' }), { code: 'CONFLICT' });

  // Live when read, booked by the time the guarded write ran.
  demand.findFirst = async () => ({ id: 'demand-1', state: 'OFFERED' });
  (db as any).$transaction = async (fn: any) =>
    fn({
      demand: { updateMany: async () => ({ count: 0 }) },
      offer: { updateMany: async () => ({ count: 0 }) },
      demandEvent: { create: async () => ({}) },
    });
  await assert.rejects(() => caller().demand.withdraw({ demandId: 'demand-1' }), { code: 'CONFLICT' });
});

/** A plan that says enough: tonight, in Midtown, for four. */
function planRow(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'plan-1',
    needs: ['dining'],
    items: [],
    startsAt: new Date(now + 3 * 60 * 60 * 1000),
    endsAt: new Date(now + 7 * 60 * 60 * 1000),
    latitude: 33.7866,
    longitude: -84.3833,
    partySize: 4,
    ...over,
  };
}

test('a plan asks for what it already says, without the guest restating it', async () => {
  plan.findFirst = async () => planRow();

  const result = await caller().demand.fromPlan({ planId: 'plan-1', needKind: 'dining' });

  assert.equal(result.state, 'OPEN');
  assert.equal(result.category, 'dining');
  assert.equal(created[0].partySize, 4);
  assert.equal(created[0].latitude, 33.7866);
  // The demand stays attached to the plan that raised it.
  assert.equal(created[0].planId, 'plan-1');
  // And obeys the same contract defaults as a typed request.
  assert.equal(created[0].radiusMiles, DEMAND_DEFAULTS.radiusMiles);
});

test('a plan that does not say enough is refused with what to fix', async () => {
  plan.findFirst = async () => planRow({ partySize: null });

  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-1', needKind: 'dining' }), {
    code: 'BAD_REQUEST',
    message: 'Say how many people are coming first.',
  });
  assert.equal(created.length, 0);
});

test('a need the vendor vocabulary cannot express is not published to the wrong sellers', async () => {
  plan.findFirst = async () => planRow({ needs: ['automotive'] });

  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-1', needKind: 'automotive' }), {
    code: 'BAD_REQUEST',
    message: 'We cannot ask vendors for that yet.',
  });
});

test('someone elses plan is indistinguishable from one that does not exist', async () => {
  plan.findFirst = async () => null;
  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-9', needKind: 'dining' }), {
    code: 'NOT_FOUND',
    message: 'Plan not found.',
  });
});

test('a need this plan never declared is not called already sorted', async () => {
  plan.findFirst = async () => planRow({ needs: ['coffee'] });

  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-1', needKind: 'dining' }), {
    code: 'NOT_FOUND',
    message: 'This plan does not have that need.',
  });
});

test('a need the plan has already sorted is not asked for again', async () => {
  // An item that fills the need closes it, so the plan no longer reports it open.
  plan.findFirst = async () => planRow({
    items: [{ needKind: 'dining', status: 'available', coffeeSpotId: null, bookableId: 'bkbl-1', partyId: null }],
  });

  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-1', needKind: 'dining' }), {
    code: 'BAD_REQUEST',
    message: 'That part of the plan is already sorted.',
  });
  assert.equal(created.length, 0);
});

test('the same gap is not asked about twice while the first ask is still live', async () => {
  plan.findFirst = async () => planRow();
  demand.findFirst = async () => ({ id: 'demand-1' });

  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-1', needKind: 'dining' }), {
    code: 'CONFLICT',
  });
  assert.equal(created.length, 0);
});

test('a plan cannot outrun the cap that applies to every other request', async () => {
  plan.findFirst = async () => planRow();
  demand.count = async () => 5;

  await assert.rejects(() => caller().demand.fromPlan({ planId: 'plan-1', needKind: 'dining' }), {
    code: 'CONFLICT',
  });
});

test('a guest sees where their payment for an offer stands', async () => {
  const { paymentState } = await import('./demandRouter');
  const now = new Date();
  const later = new Date(now.getTime() + 60_000);
  const earlier = new Date(now.getTime() - 60_000);
  assert.equal(paymentState(undefined, now), undefined);
  assert.deepEqual(paymentState({ status: 'pending', expiresAt: later, refundReason: null }, now), { state: 'paying' });
  // A checkout the processor has closed is not still paying; the guest can start again.
  assert.equal(paymentState({ status: 'pending', expiresAt: earlier, refundReason: null }, now), undefined);
  assert.equal(paymentState({ status: 'expired', expiresAt: earlier, refundReason: null }, now), undefined);
  assert.deepEqual(paymentState({ status: 'completed', expiresAt: earlier, refundReason: null }, now), { state: 'paid' });
  assert.deepEqual(
    paymentState({ status: 'refunded', expiresAt: earlier, refundReason: 'Someone took the last one.' }, now),
    { state: 'refunded', reason: 'Someone took the last one.' },
  );
});
