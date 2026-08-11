const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveProviderIdentity } = require('../dist/services/providerIdentityAuth');

const identity = { provider: 'google', subject: 'google-subject', email: 'person@example.test', name: 'Person' };
const linkedUser = { id: 'linked-user', email: 'person@example.test', name: 'Person' };

function database({ existing = null, emailOwner = null, transactionError = null, concurrent = null } = {}) {
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
    $transaction: async (operation) => {
      if (transactionError) throw transactionError;
      return operation(db);
    },
  };
  return db;
}

test('reuses the immutable provider subject without email lookup', async () => {
  const db = database({ existing: { user: linkedUser } });
  const result = await resolveProviderIdentity(identity, db);
  assert.deepEqual(result, { user: linkedUser, isNewUser: false });
});

test('refuses to auto-link an existing password account by matching email', async () => {
  const db = database({ emailOwner: { id: 'password-user' } });
  await assert.rejects(() => resolveProviderIdentity(identity, db), { code: 'CONFLICT' });
});

test('requires a token-derived email for a new Apple identity', async () => {
  const db = database();
  await assert.rejects(
    () => resolveProviderIdentity({ provider: 'apple', subject: 'apple-subject' }, db),
    { code: 'BAD_REQUEST' },
  );
});

test('creates a provider mapping using verified token claims only', async () => {
  const db = database();
  const result = await resolveProviderIdentity(identity, db);
  assert.deepEqual(result, { user: linkedUser, isNewUser: true });
});

test('recovers a concurrent first sign-in only through the same provider subject', async () => {
  const db = database({ transactionError: new Error('unique constraint'), concurrent: { user: linkedUser } });
  const result = await resolveProviderIdentity(identity, db);
  assert.deepEqual(result, { user: linkedUser, isNewUser: false });
});
