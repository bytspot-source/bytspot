import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { appRouter, signupConsent } from './router';
import { config } from '../config';
import { db } from '../lib/db';

// REA review 2026-11-10, X6 / P1.
const createCaller = createCallerFactory(appRouter);
const user = db.user as any;
const member = () => createCaller({ user: { userId: 'member-1', email: 'm@bytspot.com' }, clientRateLimitKey: 'consent' });
let stored: any;
let written: any;
const requireFlag = config.signupRequireAgeAndTerms;

beforeEach(() => {
  resetLocalRateLimitForTests();
  stored = { birthDate: null, ageConfirmedAt: null, termsVersion: null, termsAcceptedAt: null };
  written = null;
  user.findUnique = async () => stored;
  user.update = async ({ data }: any) => { written = data; Object.assign(stored, data); return stored; };
});
afterEach(() => { (config as any).signupRequireAgeAndTerms = requireFlag; });

test('status says what is missing and never returns the birth date', async () => {
  const status = await member().consent.status();
  assert.equal(status.terms.needsAcceptance, true);
  assert.equal(status.terms.currentVersion, config.termsVersion);
  assert.deepEqual(status.age, { hasBirthDate: false, confirmed18: false, canEnter21Plus: false });
  assert.ok(!JSON.stringify(status).includes('birthDate'));
});

test('terms acceptance records the current version and time, and refuses a stale one', async () => {
  await assert.rejects(() => member().consent.acceptTerms({ version: 'old' }), { code: 'CONFLICT' });
  const accepted = await member().consent.acceptTerms({ version: config.termsVersion });
  assert.equal(written.termsVersion, config.termsVersion);
  assert.ok(written.termsAcceptedAt instanceof Date);
  assert.equal(accepted.version, config.termsVersion);
});

test('a birth date is set once and the minimum age applies', async () => {
  await assert.rejects(() => member().consent.setAge({ birthDate: '2020-01-01' }), { code: 'BAD_REQUEST' });
  await member().consent.setAge({ birthDate: '1990-05-05' });
  assert.ok(written.birthDate instanceof Date);
  await assert.rejects(() => member().consent.setAge({ birthDate: '2000-05-05' }), { code: 'CONFLICT' }, 'cannot be retyped to pass a gate');
  assert.equal((await member().consent.status()).age.canEnter21Plus, true);
});

test('an 18+ confirmation unlocks 18+ but not 21+', async () => {
  await member().consent.setAge({ confirm18: true });
  const status = await member().consent.status();
  assert.equal(status.age.confirmed18, true);
  assert.equal(status.age.canEnter21Plus, false);
});

test('signup records age and terms consent when sent, and refuses an underage birth date', () => {
  const now = new Date('2026-11-10T00:00:00Z');
  const data = signupConsent({ birthDate: '1995-01-01', acceptTerms: true }, now);
  assert.equal(data.termsVersion, config.termsVersion);
  assert.equal(data.termsAcceptedAt, now);
  assert.ok(data.birthDate);
  assert.throws(() => signupConsent({ birthDate: '2020-01-01' }, now), { code: 'BAD_REQUEST' });
  assert.throws(() => signupConsent({ acceptTerms: true, termsVersion: 'stale' }, now), { code: 'CONFLICT' });
});

test('with SIGNUP_REQUIRE_AGE_AND_TERMS on, signup needs both', () => {
  (config as any).signupRequireAgeAndTerms = true;
  assert.throws(() => signupConsent({}), /Confirm your age/);
  assert.throws(() => signupConsent({ ageConfirmed18: true }), /Accept the Terms/);
  assert.ok(signupConsent({ ageConfirmed18: true, acceptTerms: true }).termsAcceptedAt);
  (config as any).signupRequireAgeAndTerms = false;
  assert.deepEqual(signupConsent({}), {}, 'shipped builds that send nothing still sign up');
});
