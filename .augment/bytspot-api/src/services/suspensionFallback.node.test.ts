import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { isSessionSuspended, resetSuspensionFallbackForTests } from './safety';

const user = db.user as any;
const brokenRedis = { exists: async () => { throw new Error('ECONNREFUSED'); } } as any;
let reads = 0;

beforeEach(() => {
  resetSuspensionFallbackForTests();
  reads = 0;
  user.findUnique = async ({ where }: any) => { reads++; return { suspendedAt: where.id === 'bad' ? new Date() : null }; };
});

test('REA V3: a Redis outage no longer lets a suspended member through', async () => {
  assert.equal(await isSessionSuspended('bad', brokenRedis), true);
  assert.equal(await isSessionSuspended('good', brokenRedis), false);
});

test('REA V3: the database fallback is cached briefly per member', async () => {
  await isSessionSuspended('bad', brokenRedis);
  await isSessionSuspended('bad', brokenRedis);
  assert.equal(reads, 1);
});

test('REA V3: no Redis in production reads the database; locally it does not', async () => {
  assert.equal(await isSessionSuspended('bad', null, { noRedisFallback: true }), true);
  assert.equal(await isSessionSuspended('bad', null, { noRedisFallback: false }), false);
});

test('REA V3: with both stores down it fails open rather than locking everyone out', async () => {
  user.findUnique = async () => { throw new Error('db down'); };
  assert.equal(await isSessionSuspended('bad', brokenRedis), false);
});

test('REA V3: a healthy Redis is still the fast path', async () => {
  const redis = { exists: async (key: string) => (key.endsWith(':bad') ? 1 : 0) } as any;
  assert.equal(await isSessionSuspended('bad', redis), true);
  assert.equal(reads, 0);
});
