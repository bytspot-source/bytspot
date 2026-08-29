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

test('A purge cancels and refunds a host\'s sales, and is held back if it cannot', async () => {
  const user = (db.user as any);
  const party = (db.party as any);
  const checkout = (db.partyCheckout as any);
  const guest = (db.partyGuest as any);
  const identityHash = (db.userIdentityHash as any);
  const deleted: string[] = [];

  user.findMany = async () => [{ id: 'host-unrefundable' }, { id: 'user-clear' }];
  user.delete = async ({ where }: any) => { deleted.push(where.id); return {}; };
  identityHash.deleteMany = async () => ({ count: 0 });
  party.findMany = async ({ where }: any) => (where.hostUserId === 'host-unrefundable' ? [{ id: 'party-1' }] : []);
  party.updateMany = async () => ({ count: 1 });
  guest.updateMany = async () => ({ count: 1 });
  checkout.updateMany = async () => ({ count: 1 });
  // A sale that took money and has not been refunded. Stripe is unconfigured
  // here, so the refund fails and the account must not be purged mid-refund.
  checkout.findMany = async ({ where }: any) => (where.status?.in?.includes('completed') ? [{ id: 'checkout-1', partyGuestId: 'guest-1' }] : []);
  checkout.findUnique = async () => ({ id: 'checkout-1', stripePaymentIntentId: 'pi_1', stripeSessionId: 'cs_1', destinationAccountId: 'acct_1', refundedAt: null, status: 'completed' });
  checkout.findFirst = async () => null;

  const result = await purgeExpiredAccounts(new Date());

  // The host who still owes ticket buyers survives; the member with nothing
  // outstanding is purged, and their payment ledger detaches rather than dying
  // with them, so a later refund is still possible.
  assert.deepEqual(deleted, ['user-clear']);
  assert.deepEqual(result, { purged: 1, heldForOwedMoney: 1 });
});
