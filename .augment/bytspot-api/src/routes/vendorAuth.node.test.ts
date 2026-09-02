import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import { readCookie, REFRESH_COOKIE } from './vendorAuth';
import { signVendorAccessToken, verifyVendorAccessToken, VENDOR_AUDIENCE } from '../vendor/accessToken';
import { AUTH } from '../vendor/contract';

const asRequest = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as Request;

test('the refresh cookie is read out of a crowded header', () => {
  const header = `ph_session=abc; ${REFRESH_COOKIE}=wanted-value; other=xyz`;
  assert.equal(readCookie(asRequest(header), REFRESH_COOKIE), 'wanted-value');
});

test('a cookie whose name is a prefix of another is not confused for it', () => {
  // byt_vendor_refresh_old must not be read as byt_vendor_refresh.
  const header = `${REFRESH_COOKIE}_old=stale; ${REFRESH_COOKIE}=current`;
  assert.equal(readCookie(asRequest(header), REFRESH_COOKIE), 'current');
});

test('a percent-encoded value is decoded', () => {
  assert.equal(readCookie(asRequest(`${REFRESH_COOKIE}=a%2Fb%3Dc`), REFRESH_COOKIE), 'a/b=c');
});

test('no cookie header, and a header without the cookie, both read as absent', () => {
  assert.equal(readCookie(asRequest(), REFRESH_COOKIE), undefined);
  assert.equal(readCookie(asRequest('unrelated=1'), REFRESH_COOKIE), undefined);
});

test('an access token round-trips with its claims', () => {
  const token = signVendorAccessToken({ userId: 'usr_1', email: 'owner@midtown.example' });
  const claims = verifyVendorAccessToken(token);
  assert.equal(claims?.userId, 'usr_1');
  assert.equal(claims?.email, 'owner@midtown.example');
});

test('a consumer token does not authenticate a vendor route', async () => {
  // The consumer app signs with the same secret, so the audience claim is the
  // only thing separating the two. Without this check a guest's token would be
  // accepted here, and a vendor's would be accepted there.
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../config');
  const consumerToken = jwt.sign({ userId: 'usr_1', email: 'guest@example.com' }, config.jwtSecret, {
    expiresIn: 900,
  });

  assert.equal(verifyVendorAccessToken(consumerToken), null);

  const wrongAudience = jwt.sign({ userId: 'usr_1', email: 'guest@example.com' }, config.jwtSecret, {
    audience: 'bytspot:guest',
    expiresIn: 900,
  });
  assert.equal(verifyVendorAccessToken(wrongAudience), null);
});

test('a token signed with another secret is refused', () => {
  const jwt = require('jsonwebtoken');
  const forged = jwt.sign({ userId: 'usr_1', email: 'a@b.c' }, 'not-the-secret', {
    audience: VENDOR_AUDIENCE,
    expiresIn: 900,
  });
  assert.equal(verifyVendorAccessToken(forged), null);
});

test('an expired token is refused', () => {
  const jwt = require('jsonwebtoken');
  const stale = jwt.sign({ userId: 'usr_1', email: 'a@b.c' }, require('../config').config.jwtSecret, {
    audience: VENDOR_AUDIENCE,
    expiresIn: -10,
  });
  assert.equal(verifyVendorAccessToken(stale), null);
});

test('a token with no subject is refused even when otherwise valid', () => {
  const jwt = require('jsonwebtoken');
  const anonymous = jwt.sign({ email: 'a@b.c' }, require('../config').config.jwtSecret, {
    audience: VENDOR_AUDIENCE,
    expiresIn: 900,
  });
  assert.equal(verifyVendorAccessToken(anonymous), null);
});

test('the access token is short-lived and the refresh long, per the shared contract', () => {
  // Both ends read these numbers. If they disagree the console refreshes either
  // too late (and 401s mid-action) or constantly.
  assert.equal(AUTH.token.accessTtlSecs, 900);
  assert.equal(AUTH.token.refreshTtlSecs, 2_592_000);
  assert.ok(AUTH.token.accessTtlSecs < AUTH.token.refreshTtlSecs);
});

test('the code contract is what the console validates against', () => {
  assert.equal(AUTH.code.length, 6);
  assert.equal(AUTH.code.maxAttempts, 3);
  assert.equal(AUTH.code.ttlSecs, 600);
  assert.equal(AUTH.code.resendCooldownSecs, 60);
});
