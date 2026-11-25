import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { db } from '../lib/db';
import { createCallerFactory, resetLocalRateLimitForTests } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import { homeTapCounts, noteHomeTap } from './homeTaps';

const homeTap = db.homeTap as any;
const saved = { create: homeTap.create, groupBy: homeTap.groupBy };
afterEach(() => { homeTap.create = saved.create; homeTap.groupBy = saved.groupBy; });

test('a Home tap stores the block only, and anyone may send one', async () => {
  resetLocalRateLimitForTests();
  const rows: unknown[] = [];
  homeTap.create = async (args: unknown) => { rows.push(args); return {}; };
  const caller = createCallerFactory(appRouter)({ user: null, clientRateLimitKey: 'home-tap-test' } as never);
  assert.deepEqual(await caller.home.tap({ block: 'near_you_now' }), { ok: true });
  assert.deepEqual(rows, [{ data: { block: 'near_you_now' } }]);
  await assert.rejects(() => caller.home.tap({ block: 'what_are_you_feeling' } as never), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller.home.tap({ block: 'start_here', userId: 'u1' } as never), { code: 'BAD_REQUEST' });
});

test('a failed write never reaches the app', async () => {
  await noteHomeTap('weather', async () => { throw new Error('db down'); });
});

test('counts list every block, zero when untapped', async () => {
  homeTap.groupBy = async () => [{ block: 'start_here', _count: { _all: 7 } }, { block: 'retired_block', _count: { _all: 2 } }];
  const counts = await homeTapCounts(new Date('2026-11-23'), new Date('2026-11-30'));
  assert.equal(counts.start_here, 7);
  assert.equal(counts.near_you_now, 0);
  assert.equal(Object.keys(counts).length, 8);
  assert.equal('retired_block' in counts, false);
});
