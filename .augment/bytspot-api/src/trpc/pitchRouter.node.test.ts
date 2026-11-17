import assert from 'node:assert/strict';
import test from 'node:test';
import { pitchUrl, readPitchCode, signPitchCode, PITCH_LINK_DAYS } from '../services/pitchLink';
import { pitchRouter, pitchView, VENDOR_JOIN_URL, type PitchDependencies } from './pitchRouter';
import { resetLocalRateLimitForTests } from './trpc';

const SOURCE = 'test-signing-source';
const zero = { total: 0, last30: 0 };
const numbers = { checkIns: { total: 9, last30: 4 }, bookingTaps: { total: 23, last30: 11 }, planAdds: zero, bookedByGuests: zero };

test('a pitch link names one place, expires, and cannot be altered', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  const { code, expiresAt } = signPitchCode('ven_1', now, SOURCE);
  assert.equal(expiresAt.getTime() - now.getTime(), PITCH_LINK_DAYS * 24 * 60 * 60 * 1000);
  assert.equal(readPitchCode(code, now, SOURCE), 'ven_1');
  assert.equal(readPitchCode(code, new Date(expiresAt.getTime() + 1000), SOURCE), null, 'expired');
  assert.equal(readPitchCode(code, now, 'another-source'), null, 'signed with another key');
  const [body, mac] = code.split('.');
  const other = signPitchCode('ven_2', now, SOURCE).code.split('.')[0];
  assert.equal(readPitchCode(`${other}.${mac}`, now, SOURCE), null, 'another place with this signature');
  for (const bad of ['', 'abc', `${body}.`, `${body}.${mac}.x`, `${body}.${mac.slice(0, -2)}`, 'x'.repeat(500)]) {
    assert.equal(readPitchCode(bad, now, SOURCE), null, bad.slice(0, 20));
  }
  assert.match(pitchUrl(code), /\/for-business\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('the pitch page shows the place and its counts, and nothing for a business already on Bytspot', async () => {
  const { code } = signPitchCode('ven_1');
  const deps = (controlledAt: Date | null): PitchDependencies => ({
    venue: async (id) => (id === 'ven_1' ? { id, name: 'Rumi\u2019s Kitchen', address: 'Colony Square', googlePlaceId: 'ChIJ1', controlledAt } : null),
    numbers: async () => numbers,
    feeBps: async () => 1000,
  });
  assert.deepEqual(await pitchView(code, deps(null)), {
    name: 'Rumi\u2019s Kitchen', address: 'Colony Square', numbers, bookingFeePercent: 10, joinUrl: VENDOR_JOIN_URL,
  });
  assert.equal(await pitchView(code, deps(new Date())), null, 'already a Bytspot business');
  assert.equal(await pitchView(signPitchCode('gone').code, deps(null)), null, 'no longer listed');
});

test('pitch.view refuses a bad link without naming a place', async () => {
  resetLocalRateLimitForTests();
  const caller = pitchRouter.createCaller({ user: null, clientRateLimitKey: 'pitch-test' });
  await assert.rejects(() => caller.view({ code: 'not-a-link' }), { code: 'NOT_FOUND' });
  resetLocalRateLimitForTests();
});
