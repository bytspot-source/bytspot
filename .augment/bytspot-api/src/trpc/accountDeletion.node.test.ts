import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

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
