import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';
import { applyDeletionPolicyOnSignIn } from '../services/accountDeletion';

const createCaller = createCallerFactory(appRouter);
const authenticated: Context = { user: { userId: 'usr_me', email: 'me@bytspot.com' }, clientRateLimitKey: 'test-deletion-client' };
const user = db.user as any;
const userIdentityHash = db.userIdentityHash as any;

const DAY_MS = 24 * 60 * 60 * 1000;

function caller() {
  return createCaller(authenticated);
}

beforeEach(() => {
  user.findUnique = async () => ({ deletedAt: null, purgeAfter: null });
  user.update = async () => ({});
  userIdentityHash.deleteMany = async () => ({ count: 0 });
});

test('requesting deletion schedules a purge 30 days out', async () => {
  let written: any = null;
  user.update = async (args: any) => { written = args.data; return {}; };

  const result = await caller().user.account.requestDeletion({ reason: 'moving city' });

  assert.equal(result.graceDays, 30);
  const scheduled = new Date(result.purgeAfter).getTime() - written.deletedAt.getTime();
  assert.equal(Math.round(scheduled / DAY_MS), 30);
  assert.equal(written.deletionReason, 'moving city');
});

test('deletion removes identity hashes immediately, before the row is purged', async () => {
  let hashesCleared = false;
  userIdentityHash.deleteMany = async () => { hashesCleared = true; return { count: 1 }; };

  await caller().user.account.requestDeletion({});

  // A member who asked to leave must stop surfacing in other people's contact
  // discovery at once, not 30 days later.
  assert.equal(hashesCleared, true);
});

test('re-requesting deletion does not extend the window', async () => {
  const purgeAfter = new Date(Date.now() + 10 * DAY_MS);
  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter });
  let updated = false;
  user.update = async () => { updated = true; return {}; };

  const result = await caller().user.account.requestDeletion({});

  assert.equal(result.purgeAfter, purgeAfter.toISOString());
  assert.equal(updated, false, 'an idempotent re-request must not reset the clock');
});

test('deletion status reports the pending state and countdown', async () => {
  const purgeAfter = new Date(Date.now() + 5 * DAY_MS);
  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter });

  const status = await caller().user.account.deletionStatus();

  assert.equal(status.pendingDeletion, true);
  assert.equal(status.purgeAfter, purgeAfter.toISOString());
});

test('cancelling inside the window restores the account', async () => {
  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + DAY_MS) });
  let written: any = null;
  user.update = async (args: any) => { written = args.data; return {}; };

  assert.deepEqual(await caller().user.account.cancelDeletion(), { restored: true });
  assert.deepEqual(written, { deletedAt: null, purgeAfter: null, deletionReason: null });
});

test('cancelling is refused once the grace period has elapsed', async () => {
  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter: new Date(Date.now() - DAY_MS) });
  await assert.rejects(() => caller().user.account.cancelDeletion(), { code: 'PRECONDITION_FAILED' });
});

test('cancelling without a pending deletion is a bad request', async () => {
  await assert.rejects(() => caller().user.account.cancelDeletion(), { code: 'BAD_REQUEST' });
});

test('account procedures require authentication', async () => {
  const anon = createCaller({ user: null, clientRateLimitKey: 'test-deletion-anon' });
  await assert.rejects(() => anon.user.account.requestDeletion({}), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => anon.user.account.deletionStatus(), { code: 'UNAUTHORIZED' });
});

test('signing in with Apple restores a pending deletion exactly as email does', async () => {
  // Provider accounts must honour the same 30-day promise: the app tells every
  // member that signing back in restores them, whatever the credential.
  const providerIdentity = db.providerIdentity as any;
  let restored = false;
  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + 10 * DAY_MS) });
  user.update = async () => { restored = true; return {}; };
  providerIdentity.findUnique = async () => ({ user: { id: 'usr_apple', email: 'apple@bytspot.com', name: 'Apple Member' } });

  const outcome = await applyDeletionPolicyOnSignIn('usr_apple');
  assert.equal(outcome, 'restored');
  assert.equal(restored, true);
});

test('a sign-in past the grace period is refused rather than silently restoring', async () => {
  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter: new Date(Date.now() - DAY_MS) });
  let updated = false;
  user.update = async () => { updated = true; return {}; };

  assert.equal(await applyDeletionPolicyOnSignIn('usr_expired'), 'purge-pending');
  assert.equal(updated, false, 'an account awaiting purge must never be revived by a sign-in');
});

test('signing in without a pending deletion changes nothing', async () => {
  user.findUnique = async () => ({ deletedAt: null, purgeAfter: null });
  let updated = false;
  user.update = async () => { updated = true; return {}; };

  assert.equal(await applyDeletionPolicyOnSignIn('usr_me'), 'none');
  assert.equal(updated, false);
});

test('an older client saving preferences does not switch party alerts back on', async () => {
  // Clients built before the party category omit it. A save must preserve the
  // member's stored choice rather than resetting it to the default.
  user.findUnique = async () => ({ notificationPrefs: { push: { party: false, nearby: true } } });
  let saved: any = null;
  user.update = async ({ data }: any) => { saved = data.notificationPrefs; return {}; };

  await caller().user.notifications.updatePrefs({
    push: { reservations: true, promotions: true, reminders: true, insider: true, nearby: false },
    email: { reservations: true, promotions: false, newsletter: true, receipts: true },
    sms: { reservations: true, reminders: true, emergencies: true },
  });

  assert.equal(saved.push.party, false, 'an omitted category keeps its stored value');
  assert.equal(saved.push.nearby, false, 'a category the client did send is updated');
});

test('a member can switch party alerts off explicitly', async () => {
  user.findUnique = async () => ({ notificationPrefs: null });
  let saved: any = null;
  user.update = async ({ data }: any) => { saved = data.notificationPrefs; return {}; };

  await caller().user.notifications.updatePrefs({
    push: { reservations: true, promotions: true, reminders: true, insider: true, nearby: false, party: false },
    email: { reservations: true, promotions: false, newsletter: true, receipts: true },
    sms: { reservations: true, reminders: true, emergencies: true },
  });

  assert.equal(saved.push.party, false);
});

test('malformed stored preferences cannot be written back or bypass an opt-out', async () => {
  // Stored JSON is untrusted: legacy rows and hand-edited values must not
  // survive a save, and a non-boolean must not read as "unset" later.
  user.findUnique = async () => ({
    notificationPrefs: { push: { party: 'garbage', extra: true }, email: ['nonsense'], sms: null },
  });
  let saved: any = null;
  user.update = async ({ data }: any) => { saved = data.notificationPrefs; return {}; };

  await caller().user.notifications.updatePrefs({
    push: { reservations: true, promotions: true, reminders: true, insider: true, nearby: false },
    email: { reservations: true, promotions: false, newsletter: true, receipts: true },
    sms: { reservations: true, reminders: true, emergencies: true },
  });

  assert.equal(saved.push.party, true, 'a non-boolean falls back to the default rather than persisting');
  assert.equal('extra' in saved.push, false, 'unknown keys are not copied into the saved shape');
  assert.deepEqual(Object.keys(saved).sort(), ['email', 'push', 'sms']);
  assert.equal(saved.email.receipts, true, 'a garbage channel rebuilds from defaults and input');
  assert.equal(saved.sms.reminders, true);
  for (const channel of Object.values(saved) as Record<string, unknown>[]) {
    for (const value of Object.values(channel)) assert.equal(typeof value, 'boolean');
  }
});

test('a stored preferences array cannot leak numeric keys into the saved shape', async () => {
  user.findUnique = async () => ({ notificationPrefs: ['garbage'] });
  let saved: any = null;
  user.update = async ({ data }: any) => { saved = data.notificationPrefs; return {}; };

  await caller().user.notifications.updatePrefs({
    push: { reservations: true, promotions: true, reminders: true, insider: true, nearby: false, party: false },
    email: { reservations: true, promotions: false, newsletter: true, receipts: true },
    sms: { reservations: true, reminders: true, emergencies: true },
  });

  assert.equal(saved.push.party, false, 'the explicit opt-out still wins');
  assert.equal('0' in saved.push, false);
});

test('reading preferences rebuilds a malformed stored record', async () => {
  user.findUnique = async () => ({
    notificationPrefs: { push: { party: 'garbage', extra: true }, email: ['nonsense'], sms: null },
  });
  const prefs: any = await caller().user.notifications.getPrefs();

  assert.equal(prefs.push.party, true, 'a non-boolean reads as the default, matching delivery');
  assert.equal('extra' in prefs.push, false);
  assert.deepEqual(Object.keys(prefs).sort(), ['email', 'push', 'sms']);
  for (const channel of Object.values(prefs) as Record<string, unknown>[]) {
    for (const value of Object.values(channel)) assert.equal(typeof value, 'boolean');
  }

  // A stored array is not a settings screen.
  user.findUnique = async () => ({ notificationPrefs: ['garbage'] });
  const fromArray: any = await caller().user.notifications.getPrefs();
  assert.equal(Array.isArray(fromArray), false);
  assert.equal(fromArray.push.party, true);

  // A genuine opt-out survives the rebuild.
  user.findUnique = async () => ({ notificationPrefs: { push: { party: false } } });
  const optedOut: any = await caller().user.notifications.getPrefs();
  assert.equal(optedOut.push.party, false, 'what the member chose is what they are shown');
});
