const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');
const { verifyProviderIdToken, resetProviderJwksCacheForTests } = require('../dist/services/providerIdTokenVerifier');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function makeToken({ provider = 'google', audience = 'google-client', claims = {}, tamper = false } = {}) {
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
  if (tamper) signature[0] ^= 1;
  return `${header}.${body}.${signature.toString('base64url')}`;
}

const jwks = async () => ({ keys: [jwk] });

for (const [name, options, expected] of [
  ['accepts a verified Google identity', {}, { provider: 'google', subject: 'provider-subject', email: 'person@example.test' }],
  ['accepts a verified Apple identity', { provider: 'apple', audience: 'apple-client' }, { provider: 'apple', subject: 'provider-subject', email: 'person@example.test' }],
]) {
  test(name, async () => {
    const result = await verifyProviderIdToken(options.provider ?? 'google', makeToken(options), options.audience ?? 'google-client', jwks);
    assert.deepEqual(result, expected);
  });
}

for (const [name, options] of [
  ['rejects a tampered signature', { tamper: true }],
  ['rejects an issuer mismatch', { claims: { iss: 'https://issuer.invalid' } }],
  ['rejects an audience mismatch', { audience: 'wrong-client' }],
  ['rejects an expired token', { claims: { exp: 1 } }],
  ['rejects an unverified Google email', { claims: { email_verified: false } }],
  ['rejects an unverified Apple email', { provider: 'apple', audience: 'apple-client', claims: { email_verified: false } }],
  ['rejects a multi-audience token without an unambiguous authorized party', { claims: { aud: ['google-client', 'other-client'] } }],
]) {
  test(name, async () => {
    const provider = options.provider ?? 'google';
    const expectedAudience = options.audience === 'wrong-client' ? 'google-client' : (options.audience ?? 'google-client');
    await assert.rejects(() => verifyProviderIdToken(provider, makeToken(options), expectedAudience, jwks));
  });
}

test('allows Apple identity without email after it is already linked', async () => {
  const result = await verifyProviderIdToken('apple', makeToken({ provider: 'apple', audience: 'apple-client', claims: { email: undefined } }), 'apple-client', jwks);
  assert.equal(result.email, undefined);
  assert.equal(result.subject, 'provider-subject');
});

test('limits unknown signing-key refreshes per provider endpoint', async () => {
  resetProviderJwksCacheForTests();
  let calls = 0;
  const unknownKidToken = makeToken();
  const [header, payload] = unknownKidToken.split('.');
  const tokenWithUnknownKid = `${base64url({ alg: 'RS256', kid: 'unknown-key', typ: 'JWT' })}.${payload}.${sign('RSA-SHA256', Buffer.from(`${base64url({ alg: 'RS256', kid: 'unknown-key', typ: 'JWT' })}.${payload}`), privateKey).toString('base64url')}`;
  const fetchUnknown = async () => { calls += 1; return { keys: [jwk] }; };
  await assert.rejects(() => verifyProviderIdToken('google', tokenWithUnknownKid, 'google-client', fetchUnknown));
  await assert.rejects(() => verifyProviderIdToken('google', tokenWithUnknownKid, 'google-client', fetchUnknown));
  assert.equal(calls, 3); // initial lookup twice, then one cached lookup; no second refresh
  resetProviderJwksCacheForTests();
});
