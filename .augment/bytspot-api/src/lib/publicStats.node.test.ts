import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appRouter } from '../trpc/router';
import { db } from './db';
import { publicStats } from './publicStats';

test('REA X7: public stats are coarse and carry no beta-lead count', async () => {
  assert.deepEqual(publicStats(273, 12), { userCount: 250, venueCount: 12 });
  assert.deepEqual(publicStats(1_234, 12), { userCount: 1_200, venueCount: 12 });
  assert.deepEqual(publicStats(23_456, 3), { userCount: 23_000, venueCount: 3 });
  (db.user as any).count = async () => 273;
  (db.venue as any).count = async () => 12;
  const out = await appRouter.createCaller({ user: null, clientRateLimitKey: 'stats' }).health.stats();
  assert.deepEqual(out, { userCount: 250, venueCount: 12 });
});

test('REA X7: exact counts are admin-only', async () => {
  await assert.rejects(() => appRouter.createCaller({ user: null, clientRateLimitKey: 'stats-a' }).health.adminStats(), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => appRouter.createCaller({ user: { userId: 'not-admin', email: 'x@bytspot.com' }, clientRateLimitKey: 'stats-b' }).health.adminStats(), { code: 'FORBIDDEN' });
});
