import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { appleIdentityAudiences, resetProviderJwksCacheForTests, verifyProviderIdToken } from './providerIdTokenVerifier';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function makeToken({
  provider = 'apple',
  audience = 'com.bytspot.app',
  claims = {},
}: {
  provider?: 'apple' | 'google';
  audience?: unknown;
  claims?: Record<string, unknown>;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: provider === 'apple' ? 'https://appleid.apple.com' : 'https://accounts.google.com',
    aud: audience,
    sub: 'provider-subject',
    exp: now + 300,
    iat: now - 5,
    email: 'person@example.test',
    email_verified: true,
    ...claims,
  };
  const header = base64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
  const body = base64url(payload);
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${signature.toString('base64url')}`;
}

const jwks = async () => ({ keys: [jwk] });

test('full-app Apple client ID also accepts the App Clip bundle audience', () => {
  assert.deepEqual(appleIdentityAudiences('com.bytspot.app'), ['com.bytspot.app', 'com.bytspot.app.Clip']);
  assert.deepEqual(appleIdentityAudiences('com.bytspot.app.Clip'), ['com.bytspot.app.Clip']);
  assert.deepEqual(appleIdentityAudiences(''), []);
});

test('accepts a verified Apple identity from the App Clip bundle', async () => {
  const result = await verifyProviderIdToken(
    'apple',
    makeToken({ audience: 'com.bytspot.app.Clip' }),
    appleIdentityAudiences('com.bytspot.app'),
    jwks,
  );
  assert.equal(result.provider, 'apple');
  assert.equal(result.subject, 'provider-subject');
  assert.equal(result.email, 'person@example.test');
});

test('still accepts a verified Apple identity from the full-app bundle', async () => {
  const result = await verifyProviderIdToken(
    'apple',
    makeToken({ audience: 'com.bytspot.app' }),
    appleIdentityAudiences('com.bytspot.app'),
    jwks,
  );
  assert.equal(result.subject, 'provider-subject');
});

test('rejects an Apple identity from any other bundle', async () => {
  await assert.rejects(() => verifyProviderIdToken(
    'apple',
    makeToken({ audience: 'com.other.app' }),
    appleIdentityAudiences('com.bytspot.app'),
    jwks,
  ));
});

test('rejects a multi-audience Apple token even when one entry is allowed', async () => {
  await assert.rejects(() => verifyProviderIdToken(
    'apple',
    makeToken({ audience: ['com.bytspot.app', 'com.bytspot.app.Clip'] }),
    appleIdentityAudiences('com.bytspot.app'),
    jwks,
  ));
});

test.after(() => resetProviderJwksCacheForTests());
