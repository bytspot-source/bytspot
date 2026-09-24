import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { db } from '../lib/db';
import {
  DELETION_GRACE_DAYS,
  isSessionRevoked,
  isWithinGracePeriod,
  purgeDateFrom,
  purgeExpiredAccounts,
  revokeSessions,
} from './accountDeletion';

// Prisma delegates are lazy proxies; node:test mock.method cannot inspect
// their methods. Replace and restore them explicitly, as router tests do.
function mockDelegate(t: TestContext, delegate: any, key: string, replacement: (...args: any[]) => any) {
  const original = delegate[key];
  delegate[key] = replacement;
  t.after(() => { delegate[key] = original; });
}

function fakeRedis(store = new Map<string, string>()) {
  return {
    store,
    async set(key: string, value: string) { store.set(key, value); return 'OK'; },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
    async exists(key: string) { return store.has(key) ? 1 : 0; },
  } as any;
}

test('permanent purge removes unconfirmed invitations in every state only for the purged account', async (t) => {
  const now = new Date('2026-09-24T12:00:00Z');
  const statuses = ['pending', 'declined', 'removed', 'withdrawn', 'accepted'];
  let entries = ['usr_gone', 'usr_active', 'opaque-unknown-id'].flatMap((invitedUserId) =>
    statuses.map((status) => ({
      invitedUserId, status, confirmedUserId: status === 'accepted' ? invitedUserId : null,
    })),
  );
  const survivors = entries.filter((row) => row.invitedUserId !== 'usr_gone');
  const order: string[] = [];
  mockDelegate(t, db.user, 'findMany', async (input: any) => {
    assert.deepEqual(input, {
      where: { deletedAt: { not: null }, purgeAfter: { lte: now } }, select: { id: true },
    });
    return [{ id: 'usr_gone' }];
  });
  mockDelegate(t, db.userIdentityHash, 'deleteMany', async ({ where }: any) => {
    assert.deepEqual(where, { userId: 'usr_gone' });
    order.push('identity');
    return { count: 1 };
  });
  mockDelegate(t, db.partyPerformer, 'deleteMany', async ({ where }: any) => {
    // No status, party or confirmed-user filter: opaque invitations need
    // explicit cleanup even when confirmation never created a user relation.
    assert.deepEqual(where, { invitedUserId: 'usr_gone' });
    const before = entries.length;
    entries = entries.filter((row) => row.invitedUserId !== where.invitedUserId);
    order.push('performers');
    return { count: before - entries.length };
  });
  mockDelegate(t, db.user, 'delete', async ({ where }: any) => {
    assert.deepEqual(where, { id: 'usr_gone' });
    assert.deepEqual(entries, survivors, 'unconfirmed invitations must already be removed');
    order.push('user');
    return { id: where.id };
  });

  assert.deepEqual(await purgeExpiredAccounts(now), { purged: 1 });
  assert.deepEqual(entries, survivors);
  assert.deepEqual(order, ['identity', 'performers', 'user']);
});

test('no eligible accounts means no invitation cleanup or user deletion', async (t) => {
  mockDelegate(t, db.user, 'findMany', async () => []);
  const unexpected = async () => { assert.fail('nothing should be deleted'); };
  mockDelegate(t, db.userIdentityHash, 'deleteMany', unexpected);
  mockDelegate(t, db.partyPerformer, 'deleteMany', unexpected);
  mockDelegate(t, db.user, 'delete', unexpected);
  assert.deepEqual(await purgeExpiredAccounts(), { purged: 0 });
});

test('failed invitation cleanup leaves the user available for a purge retry', async (t) => {
  mockDelegate(t, db.user, 'findMany', async () => [{ id: 'usr_gone' }]);
  mockDelegate(t, db.userIdentityHash, 'deleteMany', async () => ({ count: 0 }));
  mockDelegate(t, db.partyPerformer, 'deleteMany', async () => { throw new Error('cleanup failed'); });
  mockDelegate(t, db.user, 'delete', async () => { assert.fail('do not orphan unconfirmed invitations'); });
  await assert.rejects(() => purgeExpiredAccounts(), /cleanup failed/);
});

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
