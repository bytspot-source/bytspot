import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DELETION_GRACE_DAYS,
  isSessionRevoked,
  isWithinGracePeriod,
  purgeDateFrom,
  purgeExpiredAccounts,
  revokeSessions,
} from './accountDeletion';
import { owedCheckout } from './partyCheckoutSettlement';
import { db } from '../lib/db';

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

test('A purge is held back while a party payment is still unsettled', async () => {
  const user = (db.user as any);
  const checkout = (db.partyCheckout as any);
  const identityHash = (db.userIdentityHash as any);
  const deleted: string[] = [];

  user.findMany = async () => [{ id: 'user-owed' }, { id: 'user-clear' }];
  user.delete = async ({ where }: any) => { deleted.push(where.id); return {}; };
  identityHash.deleteMany = async () => ({ count: 0 });

  // The guard must look at the member as buyer and as host: a purge cascades
  // both their own checkouts and every checkout of parties they host.
  let askedFor: any;
  checkout.findFirst = async ({ where }: any) => {
    askedFor = where;
    const subjects = where.AND[0].OR;
    return subjects.some((clause: any) => clause.userId === 'user-owed' || clause.party?.hostUserId === 'user-owed')
      ? { id: 'checkout-owed' }
      : null;
  };

  const result = await purgeExpiredAccounts(new Date());

  // Only the account with nothing owed is purged; the other survives so the
  // refund it owes can still be identified and settled.
  assert.deepEqual(deleted, ['user-clear']);
  assert.deepEqual(result, { purged: 1, heldForOwedMoney: 1 });
  assert.deepEqual(askedFor.AND[0].OR, [{ userId: 'user-clear' }, { party: { hostUserId: 'user-clear' } }]);
  assert.deepEqual(askedFor.AND[1], owedCheckout);
});
