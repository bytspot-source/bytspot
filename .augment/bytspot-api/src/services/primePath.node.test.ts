import assert from 'node:assert/strict';
import { test } from 'node:test';

import { primePathReason, rankPrimePath, type PlanWindowContext, type PrimePathCandidate } from './primePath';

const ctx: PlanWindowContext = { partySize: 4, goingCount: 4 };

// A minimal viable Mode B candidate; each test overrides only what it exercises.
function candidate(overrides: Partial<PrimePathCandidate> = {}): PrimePathCandidate {
  return {
    id: 'c-1',
    label: 'The Basement',
    capability: 'book',
    ownInventory: true,
    seats: 6,
    minParty: 1,
    confirmableNow: true,
    travelMinutes: 6,
    reliability: 0.9,
    continuationValue: 0.5,
    startLabel: '8:00',
    ...overrides,
  };
}

test('Hard filter — a path that cannot be confirmed for the party in the window is dropped', () => {
  // Not confirmable now, too small for the party, or unavailable: none survive.
  const notNow = candidate({ id: 'a', confirmableNow: false });
  const tooSmall = candidate({ id: 'b', seats: 2 });
  const result = rankPrimePath([notNow, tooSmall], ctx);
  assert.equal(result.prime, null);
  assert.deepEqual(result.alternates, []);
  assert.equal(result.reason, null);
});

test('Hard filter — quorum viability drops a path that only works if more accept', () => {
  // A group table needing 6 while only 4 have committed "only works if 2 of 6
  // accept" and is never featured, even though it seats the party.
  const groupOnly = candidate({ id: 'q', minParty: 6, seats: 8 });
  const fitsCommitted = candidate({ id: 'ok', minParty: 1 });
  const result = rankPrimePath([groupOnly, fitsCommitted], ctx);
  assert.equal(result.prime?.id, 'ok');
  assert.deepEqual(result.alternates.map((c) => c.id), []);
});

test('A deep link is never Prime Path — Mode A is alternates-only', () => {
  // A redirect folds to details server-side; details is Mode A. Even as the
  // only viable path it is an alternate, never a featured Book, and no reason
  // line is written.
  const deepLink = candidate({ id: 'dl', capability: 'details', ownInventory: false });
  const result = rankPrimePath([deepLink], ctx);
  assert.equal(result.prime, null);
  assert.deepEqual(result.alternates.map((c) => c.id), ['dl']);
  assert.equal(result.reason, null);
});

test('Mode B is featured over a viable Mode A even when the deep link is closer', () => {
  // Lexicographic: Mode leads travel, so a nearer deep link still sorts below a
  // farther native path, and the deep link becomes the alternate.
  const nativeFar = candidate({ id: 'native', capability: 'request', travelMinutes: 20 });
  const deepLinkNear = candidate({ id: 'dl', capability: 'details', ownInventory: false, travelMinutes: 2 });
  const result = rankPrimePath([deepLinkNear, nativeFar], ctx);
  assert.equal(result.prime?.id, 'native');
  assert.deepEqual(result.alternates.map((c) => c.id), ['dl']);
});

test('Own inventory outranks a rented Mode B path before travel is consulted', () => {
  // Both Mode B and confirmable; the rented option is nearer, but own inventory
  // is the loop-closing supply and leads the sort ahead of travel.
  const rentedNear = candidate({ id: 'rented', ownInventory: false, travelMinutes: 1 });
  const ownFar = candidate({ id: 'own', ownInventory: true, travelMinutes: 15 });
  const result = rankPrimePath([rentedNear, ownFar], ctx);
  assert.equal(result.prime?.id, 'own');
  assert.deepEqual(result.alternates.map((c) => c.id), ['rented']);
});

test('Within one tier, lexicographic sort falls through travel → reliability → continuation', () => {
  const base = { capability: 'book' as const, ownInventory: true, confirmableNow: true, seats: 6, minParty: 1, startLabel: null };
  // Equal on mode/ownership/travel: reliability decides; then continuation.
  const a = candidate({ ...base, id: 'a', travelMinutes: 10, reliability: 0.7, continuationValue: 0.9 });
  const b = candidate({ ...base, id: 'b', travelMinutes: 10, reliability: 0.9, continuationValue: 0.1 });
  const c = candidate({ ...base, id: 'c', travelMinutes: 5, reliability: 0.1, continuationValue: 0.1 });
  const result = rankPrimePath([a, b, c], ctx);
  // Nearest first (c), then by reliability among the 10-min pair (b before a).
  assert.deepEqual([result.prime?.id, ...result.alternates.map((x) => x.id)], ['c', 'b', 'a']);
});

test('The disclosure line states the reason in one line, and only from known facts', () => {
  const full = candidate({ travelMinutes: 6, startLabel: '8:00' });
  assert.equal(primePathReason(full, ctx), '★ Prime Path — fits 4 at 8:00, 6 min away, confirmable now');
  // Unknown travel and time drop from the line rather than being invented.
  const sparse = candidate({ travelMinutes: null, startLabel: null });
  assert.equal(primePathReason(sparse, ctx), '★ Prime Path — fits 4, confirmable now');
  // A Mode A path has no Prime Path reason.
  assert.equal(primePathReason(candidate({ capability: 'details' }), ctx), null);
});

test('rankPrimePath attaches the disclosure line to the featured path', () => {
  const result = rankPrimePath([candidate({ id: 'only' })], ctx);
  assert.equal(result.prime?.id, 'only');
  assert.equal(result.reason, '★ Prime Path — fits 4 at 8:00, 6 min away, confirmable now');
});

test('No candidates yields nothing featured, not an empty-shaped default', () => {
  const result = rankPrimePath([], ctx);
  assert.deepEqual(result, { prime: null, alternates: [], reason: null });
});
