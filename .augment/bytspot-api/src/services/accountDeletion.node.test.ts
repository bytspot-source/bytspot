import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELETION_GRACE_DAYS,
  isSessionRevoked,
  isWithinGracePeriod,
  purgeDateFrom,
  revokeSessions,
} from './accountDeletion';

function fakeRedis(store = new Map<string, string>()) {
  return {
    store,
    async set(key: string, value: string) { store.set(key, value); return 'OK'; },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
    async exists(key: string) { return store.has(key) ? 1 : 0; },
  } as any;
}

test('the grace period is 30 days', () => {
  assert.equal(DELETION_GRACE_DAYS, 30);
  const requestedAt = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(purgeDateFrom(requestedAt).toISOString(), '2026-01-31T00:00:00.000Z');
});

test('grace window is open before the purge date and closed after', () => {
  const purgeAfter = new Date('2026-01-31T00:00:00.000Z');
  assert.equal(isWithinGracePeriod(purgeAfter, new Date('2026-01-30T23:59:59.000Z')), true);
  assert.equal(isWithinGracePeriod(purgeAfter, new Date('2026-01-31T00:00:01.000Z')), false);
  assert.equal(isWithinGracePeriod(null), false);
  assert.equal(isWithinGracePeriod(undefined), false);
});

test('revoking a session blocks that user and no one else', async () => {
  const redis = fakeRedis();
  await revokeSessions('usr_gone', redis);
  assert.equal(await isSessionRevoked('usr_gone', redis), true);
  assert.equal(await isSessionRevoked('usr_active', redis), false);
});

test('revocation without Redis does not lock anyone out', async () => {
  // A Redis outage must not deny the whole member base; the DB flag still
  // blocks sign-in and the purge job still runs.
  await revokeSessions('usr_gone', null);
  assert.equal(await isSessionRevoked('usr_gone', null), false);
});

test('a failing Redis fails open rather than denying every request', async () => {
  const broken = {
    async set() { throw new Error('down'); },
    async del() { throw new Error('down'); },
    async exists() { throw new Error('down'); },
  } as any;
  await revokeSessions('usr_gone', broken);
  assert.equal(await isSessionRevoked('usr_gone', broken), false);
});
