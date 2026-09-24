import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canReadPartyLineup, canonicalTipURL, normalizeTipHandle, publicTipHandles, tipHandlesInput } from './partyLineupPolicy';

test('provider-specific handles generate only canonical HTTPS recipient URLs', () => {
  assert.equal(normalizeTipHandle('cash-app', ' $DJ42 '), 'DJ42');
  assert.equal(normalizeTipHandle('cash-app', '12345'), null);
  assert.equal(normalizeTipHandle('cash-app', 'a_b'), null);
  assert.equal(normalizeTipHandle('cash-app', 'a'.repeat(21)), null);
  assert.equal(normalizeTipHandle('paypal-me', 'DJ-42'), null);
  assert.equal(normalizeTipHandle('paypal-me', 'a'.repeat(21)), null);
  assert.equal(normalizeTipHandle('venmo', '@DJ_42'), 'DJ_42');
  assert.equal(normalizeTipHandle('venmo', 'four'), null);
  assert.equal(normalizeTipHandle('venmo', 'a'.repeat(31)), null);
  assert.equal(canonicalTipURL({ provider: 'cash-app', handle: '$DJ42' }), 'https://cash.app/$DJ42');
  assert.equal(canonicalTipURL({ provider: 'paypal-me', handle: 'DJ42' }), 'https://paypal.me/DJ42');
  assert.equal(canonicalTipURL({ provider: 'venmo', handle: '@DJ_42' }), 'https://venmo.com/DJ_42');
});

test('URLs, amounts, queries, credentials, Unicode and duplicate providers fail closed', () => {
  for (const provider of ['cash-app', 'paypal-me', 'venmo'] as const) {
    for (const handle of ['https://venmo.com/good', 'good?amount=20', 'good/20', 'good#x', 'good%2Fbad', 'a@evil.test', 'good\\evil', 'ＤＪname', 'good\nname']) {
      assert.equal(normalizeTipHandle(provider, handle), null, `${provider}: ${handle}`);
    }
  }
  assert.equal(tipHandlesInput.safeParse([{ provider: 'venmo', handle: 'valid' }, { provider: 'venmo', handle: 'other' }]).success, false);
  assert.deepEqual(publicTipHandles([{ provider: 'unknown', handle: 'hello' }]), []);
  assert.deepEqual(publicTipHandles([{ provider: 'venmo', handle: 'valid', url: 'https://evil.test' }]), []);
});

const now = new Date('2026-09-24T12:00:00Z').getTime();
const party = { status: 'published', hostUserId: 'host', closedAt: null, startsAt: new Date(now - 3600000), endsAt: null, shareLinkExpiresAt: null };
test('lineup mirrors live invitation expiry including six-hour fallback and explicit override', () => {
  assert.equal(canReadPartyLineup(party, null, false, now), true);
  assert.equal(canReadPartyLineup(party, null, false, party.startsAt.getTime() + 6 * 3600000), false);
  assert.equal(canReadPartyLineup({ ...party, shareLinkExpiresAt: new Date(now) }, null, false, now), false);
  assert.equal(canReadPartyLineup({ ...party, endsAt: new Date(now - 1), shareLinkExpiresAt: new Date(now + 1) }, null, false, now), true);
});
test('confirmed guests and hosts retain expired/closed access, not draft access', () => {
  const closed = { ...party, closedAt: new Date(now), endsAt: new Date(now - 1) };
  assert.equal(canReadPartyLineup(closed, null, false, now), false);
  assert.equal(canReadPartyLineup(closed, 'performer', false, now), false);
  assert.equal(canReadPartyLineup(closed, 'host', false, now), true);
  assert.equal(canReadPartyLineup(closed, 'guest', true, now), true);
  assert.equal(canReadPartyLineup({ ...closed, status: 'draft' }, 'host', true, now), false);
});
