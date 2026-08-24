import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderIdentity, type ProviderIdentityDatabase } from './providerIdentityAuth';

const identity = { provider: 'google' as const, subject: 'google-subject', email: 'person@example.test', name: 'Person' };
const linkedUser = { id: 'linked-user', email: 'person@example.test', name: 'Person' };

function database({ existing = null, emailOwner = null, transactionError = null, concurrent = null }: {
  existing?: unknown;
  emailOwner?: unknown;
  transactionError?: Error | null;
  concurrent?: unknown;
} = {}): ProviderIdentityDatabase {
  let subjectLookups = 0;
  const db = {
    providerIdentity: {
      findUnique: async () => {
        subjectLookups += 1;
        return subjectLookups === 1 ? existing : concurrent;
      },
      create: async () => ({ id: 'provider-identity' }),
    },
    user: {
      findUnique: async () => emailOwner,
      create: async () => linkedUser,
    },
    $transaction: async (operation: (tx: unknown) => unknown) => {
      if (transactionError) throw transactionError;
      return operation(db);
    },
  };
  return db as unknown as ProviderIdentityDatabase;
}

test('An immutable provider subject is reused without ever looking up the email', async () => {
  const result = await resolveProviderIdentity(identity, database({ existing: { user: linkedUser } }));
  assert.deepEqual(result, { user: linkedUser, isNewUser: false });
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
  const result = await resolveProviderIdentity(identity, database());
  assert.deepEqual(result, { user: linkedUser, isNewUser: true });
});

test('A concurrent first sign-in recovers only through the same provider subject', async () => {
  const db = database({ transactionError: new Error('unique constraint'), concurrent: { user: linkedUser } });
  assert.deepEqual(await resolveProviderIdentity(identity, db), { user: linkedUser, isNewUser: false });
});
