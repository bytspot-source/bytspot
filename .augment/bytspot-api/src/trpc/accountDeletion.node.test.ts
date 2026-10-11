import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';
import { applyDeletionPolicyOnSignIn } from '../services/accountDeletion';
import { redisHandle, type RedisLike } from '../vendor/redisHandle';
import { createChallenge } from '../vendor/otp';
import { issueRefreshToken } from '../vendor/refreshTokens';
import { TRPCError } from '@trpc/server';
import { ProviderLinkRequired, holdPendingLink } from '../services/providerLink';
import { holdPendingEmail } from '../services/accountEmails';
import { hashEmail } from '../lib/contactHash';
import bcrypt from 'bcryptjs';
import { config } from '../config';

const createCaller = createCallerFactory(appRouter);
const authenticated: Context = { user: { userId: 'usr_me', email: 'me@bytspot.com' }, clientRateLimitKey: 'test-deletion-client' };
const user = db.user as any;
const userIdentityHash = db.userIdentityHash as any;
const userEmail = db.userEmail as any;

const DAY_MS = 24 * 60 * 60 * 1000;

function caller() {
  return createCaller(authenticated);
}

beforeEach(() => {
  user.findUnique = async () => ({ deletedAt: null, purgeAfter: null });
  user.update = async () => ({});
  userIdentityHash.deleteMany = async () => ({ count: 0 });
  userEmail.findMany = async () => [];
  userEmail.findUnique = async () => null;
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

// "Forgot password" signs the member in, so it follows the same deletion policy.
function codeStore(): RedisLike {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => { store.set(key, value); return 'OK'; },
    del: async (...keys) => keys.filter((key) => store.delete(key)).length,
    ttl: async (key) => (store.has(key) ? 600 : -2),
    incr: async (key) => { const next = Number(store.get(key) ?? 0) + 1; store.set(key, String(next)); return next; },
    expire: async () => 1,
    getdel: async (key) => { const value = store.get(key) ?? null; store.delete(key); return value; },
  };
}

function resetCaller(key: string) {
  return createCaller({ user: null, clientRateLimitKey: key });
}

test('a password reset with the emailed code sets the password, confirms the email and signs in', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const { id, code } = await createChallenge('ama@bytspot.com', 'usr_reset', 'reset');
  user.findUnique = async (args: any) => (args.select?.emailVerifiedAt ? { emailVerifiedAt: null } : { deletedAt: null, purgeAfter: null });
  let written: any = null;
  user.update = async (args: any) => { written = args.data; return { id: 'usr_reset', email: 'ama@bytspot.com', name: 'Ama' }; };

  const result = await resetCaller('test-reset-ok').auth.resetPassword({ challengeId: id, code, password: 'a-new-password' });

  assert.equal(typeof result.token, 'string');
  assert.equal(typeof result.refreshToken, 'string');
  assert.deepEqual(result.user, { id: 'usr_reset', email: 'ama@bytspot.com', name: 'Ama' });
  assert.equal(result.emailVerified, true);
  assert.equal(result.deletionCancelled, false);
  assert.notEqual(written.password, 'a-new-password', 'only the hash is stored');
  assert.ok(written.emailVerifiedAt instanceof Date, 'the code proves the member owns the address');
  assert.ok(written.passwordSetAt instanceof Date, 'an Apple or Google account now also has email sign-in');
  // Single use.
  await assert.rejects(() => resetCaller('test-reset-ok').auth.resetPassword({ challengeId: id, code, password: 'a-new-password' }), { code: 'BAD_REQUEST' });
});

test('a wrong reset code changes nothing and says so', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const { id, code } = await createChallenge('ama@bytspot.com', 'usr_reset', 'reset');
  user.update = async () => { assert.fail('a wrong code must not change the password'); };

  await assert.rejects(
    () => resetCaller('test-reset-wrong').auth.resetPassword({ challengeId: id, code: code === '000000' ? '111111' : '000000', password: 'a-new-password' }),
    { code: 'BAD_REQUEST', message: "That code isn't right. Check the email and try again." },
  );
});

test('a reset code for an address with no password account never sets a password', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const { id, code } = await createChallenge('nobody@bytspot.com', '', 'reset');
  user.update = async () => { assert.fail('no account may be changed'); };

  await assert.rejects(
    () => resetCaller('test-reset-decoy').auth.resetPassword({ challengeId: id, code, password: 'a-new-password' }),
    { code: 'BAD_REQUEST', message: 'This code has expired. Send a new one.' },
  );
});

test('a password reset restores a pending deletion like any other sign-in', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const { id, code } = await createChallenge('ama@bytspot.com', 'usr_reset', 'reset');
  user.findUnique = async (args: any) => (args.select?.emailVerifiedAt
    ? { emailVerifiedAt: new Date() }
    : { deletedAt: new Date(), purgeAfter: new Date(Date.now() + DAY_MS) });
  user.update = async () => ({ id: 'usr_reset', email: 'ama@bytspot.com', name: 'Ama' });

  const result = await resetCaller('test-reset-restore').auth.resetPassword({ challengeId: id, code, password: 'a-new-password' });
  assert.equal(result.deletionCancelled, true);
});

test('a refresh token renews the session once and is then spent', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const first = await issueRefreshToken('usr_me', 'member');
  user.findUnique = async () => ({ id: 'usr_me', email: 'me@bytspot.com', deletedAt: null });

  const renewed = await resetCaller('test-refresh-ok').auth.refresh({ refreshToken: first });
  assert.equal(typeof renewed.token, 'string');
  assert.notEqual(renewed.refreshToken, first);
  // Replaying the spent token ends the sign-in, including its replacement.
  await assert.rejects(() => resetCaller('test-refresh-ok').auth.refresh({ refreshToken: first }), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => resetCaller('test-refresh-ok').auth.refresh({ refreshToken: renewed.refreshToken }), { code: 'UNAUTHORIZED' });
});

test('a pending deletion stops renewal; only signing in again restores the account', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const token = await issueRefreshToken('usr_me', 'member');
  user.findUnique = async () => ({ id: 'usr_me', email: 'me@bytspot.com', deletedAt: new Date() });

  await assert.rejects(() => resetCaller('test-refresh-deleted').auth.refresh({ refreshToken: token }), { code: 'UNAUTHORIZED' });
});

test('a password reset ends every earlier sign-in on other devices', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const otherDevice = await issueRefreshToken('usr_reset', 'member');
  const { id, code } = await createChallenge('ama@bytspot.com', 'usr_reset', 'reset');
  user.findUnique = async (args: any) => (args.select?.emailVerifiedAt
    ? { emailVerifiedAt: new Date() }
    : args.select?.email ? { id: 'usr_reset', email: 'ama@bytspot.com', deletedAt: null } : { deletedAt: null, purgeAfter: null });
  user.update = async () => ({ id: 'usr_reset', email: 'ama@bytspot.com', name: 'Ama' });
  const realNow = Date.now;
  Date.now = () => realNow() + 5;
  try {
    const reset = await resetCaller('test-reset-signout').auth.resetPassword({ challengeId: id, code, password: 'a-new-password' });
    await assert.rejects(() => resetCaller('test-reset-signout').auth.refresh({ refreshToken: otherDevice }), { code: 'UNAUTHORIZED' });
    assert.equal(typeof (await resetCaller('test-reset-signout').auth.refresh({ refreshToken: reset.refreshToken! })).token, 'string');
  } finally {
    Date.now = realNow;
  }
});

test('signing out ends that refresh token', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const token = await issueRefreshToken('usr_me', 'member');
  assert.deepEqual(await resetCaller('test-sign-out').auth.signOut({ refreshToken: token }), { signedOut: true });
  await assert.rejects(() => resetCaller('test-sign-out').auth.refresh({ refreshToken: token }), { code: 'UNAUTHORIZED' });
});

function linkAccount(emailVerifiedAt: Date | null) {
  user.findUnique = async (args: any) => (args.select?.name
    ? { id: 'usr_link', email: 'ama@bytspot.com', name: 'Ama', emailVerifiedAt }
    : { id: 'usr_link', email: 'ama@bytspot.com', deletedAt: null, purgeAfter: null });
  const created: unknown[] = [];
  const providerIdentity = db.providerIdentity as any;
  providerIdentity.findUnique = async () => null;
  providerIdentity.findFirst = async () => null;
  providerIdentity.create = async (args: any) => { created.push(args.data); return {}; };
  return created;
}

async function linkChallenge() {
  const { id, code } = await createChallenge('ama@bytspot.com', 'usr_link', 'link');
  await holdPendingLink(id, { provider: 'apple', subject: 'apple-sub' });
  return { id, code };
}

test('the emailed link code adds Apple to the existing account and signs in', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const created = linkAccount(new Date());
  user.update = async () => assert.fail('a confirmed account keeps its password');
  const { id, code } = await linkChallenge();

  const result = await resetCaller('test-link-ok').auth.confirmLink({ challengeId: id, code });

  assert.equal(typeof result.token, 'string');
  assert.equal(typeof result.refreshToken, 'string');
  assert.deepEqual(result.user, { id: 'usr_link', email: 'ama@bytspot.com', name: 'Ama' });
  assert.equal(result.linkedProvider, 'apple');
  assert.deepEqual(created, [{ provider: 'apple', subject: 'apple-sub', userId: 'usr_link' }]);
  // Single use.
  await assert.rejects(() => resetCaller('test-link-ok').auth.confirmLink({ challengeId: id, code }), { code: 'BAD_REQUEST' });
});

test('a wrong link code links nothing and says so', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  linkAccount(new Date());
  (db.providerIdentity as any).create = async () => assert.fail('a wrong code must not link');
  const { id, code } = await linkChallenge();

  await assert.rejects(
    () => resetCaller('test-link-wrong').auth.confirmLink({ challengeId: id, code: code === '000000' ? '111111' : '000000' }),
    { code: 'BAD_REQUEST', message: "That code isn't right. Check the email and try again." },
  );
});

test('linking to an unconfirmed account ends its password and every other sign-in', async () => {
  // Whoever signed up with this address never proved it. The code proves the
  // linking member does, so the unproven password must stop working.
  const store = codeStore();
  redisHandle.get = () => store;
  linkAccount(null);
  let written: any = null;
  user.update = async (args: any) => { written = args.data; return {}; };
  const otherDevice = await issueRefreshToken('usr_link', 'member');
  const { id, code } = await linkChallenge();
  const realNow = Date.now;
  Date.now = () => realNow() + 5;
  try {
    const result = await resetCaller('test-link-unconfirmed').auth.confirmLink({ challengeId: id, code });
    assert.equal(typeof result.token, 'string');
    assert.ok(written.emailVerifiedAt instanceof Date);
    assert.equal(written.passwordSetAt, null);
    assert.equal(typeof written.password, 'string');
    await assert.rejects(() => resetCaller('test-link-unconfirmed').auth.refresh({ refreshToken: otherDevice }), { code: 'UNAUTHORIZED' });
  } finally {
    Date.now = realNow;
  }
});

test('a provider ID another account uses is never moved by a link code', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  linkAccount(new Date());
  (db.providerIdentity as any).findUnique = async () => ({ userId: 'usr_someone_else' });
  const { id, code } = await linkChallenge();

  await assert.rejects(() => resetCaller('test-link-taken').auth.confirmLink({ challengeId: id, code }), { code: 'CONFLICT' });
});

test('the sign-in CONFLICT tells the app which code to ask for', () => {
  const format = (appRouter._def as any)._config.errorFormatter;
  const shape = { message: 'An account already exists for this email.', code: -32009, data: { code: 'CONFLICT', httpStatus: 409 } };
  const linking = new TRPCError({ code: 'CONFLICT', message: shape.message, cause: new ProviderLinkRequired('chal_1', 'a••@bytspot.com', 'google') });
  assert.deepEqual(format({ shape, error: linking }).data.link, { challengeId: 'chal_1', maskedEmail: 'a••@bytspot.com', provider: 'google' });
  // Without a code to ask for, the error is exactly what older apps already handle.
  assert.deepEqual(format({ shape, error: new TRPCError({ code: 'CONFLICT', message: shape.message }) }), shape);
});

test('sign-in methods report a chosen password and each linked provider', async () => {
  user.findUnique = async () => ({ passwordSetAt: null });
  (db.providerIdentity as any).findMany = async () => [{ provider: 'apple' }];

  assert.deepEqual(await caller().auth.signInMethods(), { password: false, apple: true, google: false });
});

test('the last way into an account cannot be removed', async () => {
  user.findUnique = async () => ({ passwordSetAt: null });
  const providerIdentity = db.providerIdentity as any;
  providerIdentity.findMany = async () => [{ provider: 'apple' }];
  providerIdentity.deleteMany = async () => assert.fail('the only sign-in method must stay');
  await assert.rejects(() => caller().auth.unlinkProvider({ provider: 'apple' }), { code: 'PRECONDITION_FAILED' });

  let removed: any = null;
  providerIdentity.findMany = async () => [{ provider: 'apple' }, { provider: 'google' }];
  providerIdentity.deleteMany = async (args: any) => { removed = args.where; return { count: 1 }; };
  assert.deepEqual(await caller().auth.unlinkProvider({ provider: 'apple' }), { password: false, apple: false, google: true });
  assert.deepEqual(removed, { userId: 'usr_me', provider: 'apple' });
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

// ── Extra emails ──
function emailsAccount({ confirmed = true, extras = [] as string[] } = {}) {
  const rows = extras.map((email) => ({ id: `ue_${email}`, email, createdAt: new Date('2026-10-01T00:00:00Z') }));
  user.findUnique = async () => ({ email: 'Me@bytspot.com', emailVerifiedAt: confirmed ? new Date() : null });
  user.findFirst = async () => null;
  userEmail.findMany = async () => rows.map(({ email, createdAt }) => ({ email, createdAt }));
  userEmail.findFirst = async (args: any) => rows.find((row) => row.email === args.where.email) ?? null;
  userEmail.create = async (args: any) => { rows.push({ id: `ue_${args.data.email}`, email: args.data.email, createdAt: new Date() }); return {}; };
  return rows;
}

function hashWrites() {
  const written: any[] = [];
  const realTransaction = (db as any).$transaction;
  (db as any).$transaction = async (ops: unknown[]) => Promise.all(ops);
  userIdentityHash.createMany = async ({ data }: any) => { written.push(...data); return { count: data.length }; };
  return { written, restore: () => { (db as any).$transaction = realTransaction; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('an email already on the account, an unconfirmed account email or a full list refuses a new email', async () => {
  emailsAccount();
  await assert.rejects(() => caller().auth.addEmail({ email: 'me@BYTSPOT.com' }), { code: 'BAD_REQUEST', message: 'This email is already on your account.' });

  // Whoever signed up with an unconfirmed address may not own it; an extra
  // email would keep them a way in after the real owner claims it.
  emailsAccount({ confirmed: false });
  await assert.rejects(() => caller().auth.addEmail({ email: 'ama@gmail.com' }), { code: 'PRECONDITION_FAILED', message: 'Confirm your account email first.' });

  emailsAccount({ extras: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'] });
  await assert.rejects(() => caller().auth.addEmail({ email: 'ama@gmail.com' }), { code: 'PRECONDITION_FAILED' });
});

test('the emailed code adds the email, and it joins contact discovery', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const rows = emailsAccount();
  const hashes = hashWrites();
  try {
    const { id, code } = await createChallenge('ama@gmail.com', 'usr_me', 'email');
    await holdPendingEmail(id, { email: 'ama@gmail.com', makeAccountEmail: false });

    const result = await caller().auth.confirmAddEmail({ challengeId: id, code });
    await settle();

    assert.deepEqual(rows.map((row) => row.email), ['ama@gmail.com']);
    assert.deepEqual(result.accountEmail, { email: 'Me@bytspot.com', confirmed: true });
    assert.deepEqual(result.extraEmails.map((extra) => extra.email), ['ama@gmail.com']);
    assert.equal(result.maxExtraEmails, 5);
    assert.deepEqual(hashes.written.map((row) => row.hashedIdentity).sort(), [hashEmail('Me@bytspot.com'), hashEmail('ama@gmail.com')].sort());
    // Single use.
    await assert.rejects(() => caller().auth.confirmAddEmail({ challengeId: id, code }), { code: 'BAD_REQUEST' });
  } finally {
    hashes.restore();
  }
});

test("another member's code, or an address another account took meanwhile, adds nothing", async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const rows = emailsAccount();

  const theirs = await createChallenge('ama@gmail.com', 'usr_someone_else', 'email');
  await holdPendingEmail(theirs.id, { email: 'ama@gmail.com', makeAccountEmail: false });
  await assert.rejects(() => caller().auth.confirmAddEmail({ challengeId: theirs.id, code: theirs.code }), { code: 'BAD_REQUEST', message: 'This code has expired. Send a new one.' });

  // The code reached the mailbox, so saying the address is taken reveals nothing new.
  user.findFirst = async () => ({ id: 'usr_other' });
  const mine = await createChallenge('ama@gmail.com', 'usr_me', 'email');
  await holdPendingEmail(mine.id, { email: 'ama@gmail.com', makeAccountEmail: false });
  await assert.rejects(() => caller().auth.confirmAddEmail({ challengeId: mine.id, code: mine.code }), { code: 'CONFLICT' });
  assert.deepEqual(rows, []);
});

test('making an extra email the account email keeps the old one as an extra email', async () => {
  emailsAccount({ extras: ['ama@gmail.com'] });
  const realTransaction = (db as any).$transaction;
  (db as any).$transaction = async (ops: unknown[]) => Promise.all(ops);
  const writes: Record<string, unknown> = {};
  userEmail.delete = async (args: any) => { writes.deleted = args.where; return {}; };
  user.update = async (args: any) => { writes.account = args.data; return {}; };
  userEmail.create = async (args: any) => { writes.demoted = args.data; return {}; };
  try {
    await caller().auth.makeAccountEmail({ email: 'Ama@Gmail.com' });
    assert.deepEqual(writes, {
      deleted: { id: 'ue_ama@gmail.com' },
      account: { email: 'ama@gmail.com' },
      demoted: { userId: 'usr_me', email: 'me@bytspot.com' },
    });
    await assert.rejects(() => caller().auth.makeAccountEmail({ email: 'nobody@gmail.com' }), { code: 'NOT_FOUND' });
  } finally {
    (db as any).$transaction = realTransaction;
  }
});

test('an extra email can be removed and leaves contact discovery; the account email cannot', async () => {
  emailsAccount({ extras: ['ama@gmail.com'] });
  userEmail.deleteMany = async () => assert.fail('the account email must stay');
  await assert.rejects(() => caller().auth.removeEmail({ email: 'ME@bytspot.com' }), { code: 'BAD_REQUEST', message: 'Make another email your account email first.' });

  const rows = emailsAccount({ extras: ['ama@gmail.com'] });
  const hashes = hashWrites();
  let removed: any = null;
  userEmail.deleteMany = async (args: any) => { removed = args.where; rows.length = 0; return { count: 1 }; };
  try {
    const result = await caller().auth.removeEmail({ email: 'ama@gmail.com' });
    assert.deepEqual(removed, { userId: 'usr_me', email: 'ama@gmail.com' });
    assert.deepEqual(result.extraEmails, []);
    assert.deepEqual(hashes.written.map((row) => row.hashedIdentity), [hashEmail('Me@bytspot.com')]);
  } finally {
    hashes.restore();
  }
});

test('an extra email signs in with the password and cannot be used to sign up again', async () => {
  const store = codeStore();
  redisHandle.get = () => store;
  const password = await bcrypt.hash('a-good-password', 4);
  user.findUnique = async (args: any) => (args.where.email
    ? null
    : { id: 'usr_me', email: 'Me@bytspot.com', name: 'Me', password, emailVerifiedAt: new Date(), deletedAt: null, purgeAfter: null });
  userEmail.findUnique = async (args: any) => (args.where.email === 'ama@gmail.com' ? { userId: 'usr_me' } : null);

  const session = await resetCaller('test-extra-login').auth.login({ email: 'Ama@Gmail.com', password: 'a-good-password' });
  assert.deepEqual(session.user, { id: 'usr_me', email: 'Me@bytspot.com', name: 'Me' });
  await assert.rejects(() => resetCaller('test-extra-login').auth.login({ email: 'ama@gmail.com', password: 'wrong-password' }), { code: 'UNAUTHORIZED' });

  user.create = async () => assert.fail('an address on another account must not sign up');
  await assert.rejects(() => resetCaller('test-extra-signup').auth.signup({ email: 'ama@gmail.com', password: 'a-good-password' }), { code: 'CONFLICT', message: 'Email already registered' });
});

// ── Invite codes ──
test('the invite code is issued once and the link carries it', async () => {
  let stored: string | null = null;
  let issued = 0;
  user.findUnique = async () => ({ inviteCode: stored });
  user.updateMany = async (args: any) => { issued += 1; stored = args.data.inviteCode; return { count: 1 }; };
  // Only invited accounts with a confirmed email count.
  user.count = async (args: any) => (args.where.ref === 'usr_me' && args.where.emailVerifiedAt?.not === null ? 2 : 0);

  const first = await caller().auth.invite();
  assert.match(first.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.equal(first.link, `https://bytspot.app/?ref=${first.code}`);
  assert.equal(first.referralCount, 2);
  assert.deepEqual(await caller().auth.invite(), first);
  assert.equal(issued, 1);
});

test('signing up with an invite code in any letter case credits the inviter', async () => {
  const created: any[] = [];
  user.findUnique = async (args: any) => (args.where.inviteCode === 'AMA7K2' ? { id: 'usr_inviter' } : null);
  user.create = async (args: any) => { created.push(args.data); return { id: 'usr_new', email: args.data.email, name: null }; };

  await resetCaller('test-invite-signup').auth.signup({ email: 'friend@gmail.com', password: 'a-good-password', ref: ' ama7k2 ' });
  await resetCaller('test-invite-signup-2').auth.signup({ email: 'other@gmail.com', password: 'a-good-password', ref: 'vibecheck' });
  assert.deepEqual(created.map((data) => data.ref), ['usr_inviter', 'vibecheck']);
});

// ── Welcome email ──
// Last in the file: it installs a fake mail client, which stays for the
// rest of the run.
test('a password account is welcomed when its email is confirmed, never at signup', async () => {
  const sent: string[] = [];
  require.cache[require.resolve('resend')] = { exports: { Resend: class { emails = { send: async (mail: any) => { sent.push(mail.to); return {}; } }; } } } as any;
  (config as any).resendApiKey = 'test-key';
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  user.findUnique = async () => null;
  user.create = async (args: any) => ({ id: 'usr_me', email: args.data.email, name: null });
  await resetCaller('test-welcome-signup').auth.signup({ email: 'someone@theircompany.com', password: 'a-good-password' });
  await flush();
  assert.deepEqual(sent, []);

  const store = codeStore();
  redisHandle.get = () => store;
  userIdentityHash.deleteMany = async () => ({ count: 0 });
  userIdentityHash.createMany = async () => ({ count: 0 });
  const confirm = async (createdAt: Date) => {
    user.update = async () => ({ id: 'usr_me', email: 'me@bytspot.com', name: 'Ama Owusu', createdAt });
    const { id, code } = await createChallenge('me@bytspot.com', 'usr_me', 'member');
    await caller().auth.verifyEmail({ challengeId: id, code });
    await flush();
  };
  await confirm(new Date());
  assert.deepEqual(sent, ['me@bytspot.com']);

  // Accounts from before the change were welcomed at signup.
  await confirm(new Date('2026-09-01T00:00:00Z'));
  assert.deepEqual(sent, ['me@bytspot.com']);
});
