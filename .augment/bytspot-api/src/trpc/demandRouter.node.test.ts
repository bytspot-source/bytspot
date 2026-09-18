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
  assert.equal(logged.kind, 'RAISED');
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
