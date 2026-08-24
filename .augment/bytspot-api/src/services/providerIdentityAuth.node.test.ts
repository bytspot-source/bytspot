import test from 'node:test';
import assert from 'node:assert/strict';

import { hashEmail } from '../lib/contactHash';
import { resolveProviderIdentity, type ProviderIdentityDatabase } from './providerIdentityAuth';

const identity = { provider: 'google' as const, subject: 'google-subject', email: 'person@example.test', name: 'Person' };
const linkedUser = { id: 'linked-user', email: 'person@example.test', name: 'Person' };

type FakeDatabase = ProviderIdentityDatabase & { emailLookups: () => number; identityHashRows: () => unknown[] };

function database({ existing = null, emailOwner = null, transactionError = null, concurrent = null }: {
  existing?: unknown;
  emailOwner?: unknown;
  transactionError?: Error | null;
  concurrent?: unknown;
} = {}): FakeDatabase {
  let subjectLookups = 0;
  let emailLookups = 0;
  const identityHashRows: unknown[] = [];
  const db = {
    providerIdentity: {
      findUnique: async () => {
        subjectLookups += 1;
        return subjectLookups === 1 ? existing : concurrent;
      },
      create: async () => ({ id: 'provider-identity' }),
    },
    user: {
      findUnique: async () => { emailLookups += 1; return emailOwner; },
      create: async () => linkedUser,
    },
    userIdentityHash: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }: { data: unknown[] }) => { identityHashRows.push(...data); return { count: data.length }; },
    },
    // Prisma takes either a callback or an array of operations; the identity
    // hash refresh uses the array form.
    $transaction: async (arg: unknown) => {
      if (transactionError) throw transactionError;
      return Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(db);
    },
  };
  return Object.assign(db as unknown as ProviderIdentityDatabase, {
    emailLookups: () => emailLookups,
    identityHashRows: () => identityHashRows,
  }) as FakeDatabase;
}

test('An immutable provider subject is reused without ever looking up the email', async () => {
  const db = database({ existing: { user: linkedUser } });
  assert.deepEqual(await resolveProviderIdentity(identity, db), { user: linkedUser, isNewUser: false });
  // The title is the assertion: a subject hit must not reach the email lookup,
  // which is the path that could link an account it should not.
  assert.equal(db.emailLookups(), 0);
});

test('A matching email does not auto-link an existing password account', async () => {
  // This is the account-takeover boundary: whoever controls an email at a
  // provider must not thereby control the password account that used it.
  await assert.rejects(() => resolveProviderIdentity(identity, database({ emailOwner: { id: 'password-user' } })), { code: 'CONFLICT' });
});

test('A new Apple identity without a token-derived email is refused', async () => {
  await assert.rejects(
    () => resolveProviderIdentity({ provider: 'apple', subject: 'apple-subject' }, database()),
    { code: 'BAD_REQUEST' },
  );
});

test('A provider mapping is created from verified token claims only', async () => {
  const db = database();
  assert.deepEqual(await resolveProviderIdentity(identity, db), { user: linkedUser, isNewUser: true });

  // The hash refresh is fire-and-forget, so let it land. It runs against the
  // caller's database rather than the module client: untested, it reached real
  // Prisma from every suite and failed silently.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(db.identityHashRows(), [{ userId: 'linked-user', hashedIdentity: hashEmail(identity.email), kind: 'email' }]);
});

test('A concurrent first sign-in recovers only through the same provider subject', async () => {
  const db = database({ transactionError: new Error('unique constraint'), concurrent: { user: linkedUser } });
  assert.deepEqual(await resolveProviderIdentity(identity, db), { user: linkedUser, isNewUser: false });
});
