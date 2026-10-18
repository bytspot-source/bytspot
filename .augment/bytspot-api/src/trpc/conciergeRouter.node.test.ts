import assert from 'node:assert/strict';
import test from 'node:test';
import { appRouter } from './router';
import { conciergeDiscoveryRouter } from './conciergeRouter';
import { resetLocalRateLimitForTests } from './trpc';
import type { Context } from './context';
import { config } from '../config';

const originalEnabled = config.conciergeDiscoveryEnabled;
test.beforeEach(() => { Object.assign(config, { conciergeDiscoveryEnabled: true }); });
test.afterEach(() => { Object.assign(config, { conciergeDiscoveryEnabled: originalEnabled }); });

const member: Context = { user: { userId: 'concierge-test-user', email: 'member@example.test' }, clientRateLimitKey: 'concierge-test' };
const missingLocation = { messages: [{ role: 'user' as const, content: 'coffee' }] };

test('new discover mutation is mounted alongside the unchanged legacy chat', async () => {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  assert.equal(procedures['concierge.chat']._def.type, 'mutation');
  assert.equal(procedures['concierge.discover']._def.type, 'mutation');
  const caller = appRouter.createCaller({ user: null, clientRateLimitKey: 'concierge-anon' });
  await assert.rejects(() => caller.concierge.discover(missingLocation), { code: 'UNAUTHORIZED' });
});

test('new route validates input and returns the agreed location-required wire shape', async () => {
  resetLocalRateLimitForTests();
  const caller = conciergeDiscoveryRouter.createCaller(member);
  await assert.rejects(() => caller.discover({ messages: Array(11).fill({ role: 'user', content: 'coffee' }) }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller.discover({ ...missingLocation, location: { lat: 91, lng: 0 } }), { code: 'BAD_REQUEST' });
  const response = await caller.discover(missingLocation);
  assert.deepEqual(response, { version: 1, status: 'needs_location', reply: 'Share or choose a location to find real places nearby.', cards: [], refinements: [] });
  resetLocalRateLimitForTests();
});

test('disabled discovery returns no cards without running search adapters', async () => {
  resetLocalRateLimitForTests();
  Object.assign(config, { conciergeDiscoveryEnabled: false });
  const result = await conciergeDiscoveryRouter.createCaller(member).discover({
    ...missingLocation, location: { lat: 47.6062, lng: -122.3321 },
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reply, /not enabled/);
  assert.deepEqual(result.cards, []);
});

test('discover has its own per-user 20-per-minute rate limit', async () => {
  resetLocalRateLimitForTests();
  const caller = conciergeDiscoveryRouter.createCaller({ ...member, user: { ...member.user!, userId: 'concierge-rate-test' } });
  for (let n = 0; n < 20; n++) await caller.discover(missingLocation);
  await assert.rejects(() => caller.discover(missingLocation), { code: 'TOO_MANY_REQUESTS' });
  resetLocalRateLimitForTests();
});

test('identifyDish is authenticated, flag-gated and rate limited without calling the provider for invalid photos', async () => {
  resetLocalRateLimitForTests();
  const originalPhoto = config.conciergePhotoEnabled;
  try {
    const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
    assert.equal(procedures['concierge.identifyDish']._def.type, 'mutation');
    const invalid = { image: 'data:image/png;base64,AAAA' };
    await assert.rejects(() => appRouter.createCaller({ user: null, clientRateLimitKey: 'dish-anon' }).concierge.identifyDish(invalid), { code: 'UNAUTHORIZED' });

    const caller = conciergeDiscoveryRouter.createCaller({ ...member, user: { ...member.user!, userId: 'concierge-dish-test' } });
    Object.assign(config, { conciergePhotoEnabled: false });
    const disabled = await caller.identifyDish(invalid);
    assert.equal(disabled.status, 'unavailable');
    assert.deepEqual(disabled.candidates, []);
    Object.assign(config, { conciergePhotoEnabled: true, conciergeDiscoveryEnabled: false });
    assert.equal((await caller.identifyDish(invalid)).status, 'unavailable');

    Object.assign(config, { conciergePhotoEnabled: true, conciergeDiscoveryEnabled: true });
    assert.equal((await caller.identifyDish(invalid)).status, 'invalid_photo');
    await assert.rejects(() => caller.identifyDish({ image: invalid.image, extra: true } as never), { code: 'BAD_REQUEST' });
    for (let n = 0; n < 2; n++) await caller.identifyDish(invalid);
    await assert.rejects(() => caller.identifyDish(invalid), { code: 'TOO_MANY_REQUESTS' });
  } finally {
    Object.assign(config, { conciergePhotoEnabled: originalPhoto });
    resetLocalRateLimitForTests();
  }
});
