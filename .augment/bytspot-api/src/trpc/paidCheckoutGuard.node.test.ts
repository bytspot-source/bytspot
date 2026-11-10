import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { appRouter } from './router';
import { config } from '../config';
import { db } from '../lib/db';
import { clientPlatformOf, type Context } from './context';

// REA review 2026-11-10, X5 and P5.
const createCaller = createCallerFactory(appRouter);
const user = db.user as any;
const saved = { nodeEnv: config.nodeEnv, key: config.stripeSecretKey, enabled: config.paidCheckoutEnabled };
const ctx = (clientPlatform?: 'ios' | 'web'): Context => ({
  user: { userId: 'buyer-1', email: 'buyer@bytspot.com' }, clientRateLimitKey: 'paid-guard', clientPlatform,
});

beforeEach(() => {
  resetLocalRateLimitForTests();
  user.findUnique = async () => ({ stripeCustomerId: 'cus_1', email: 'buyer@bytspot.com', isPremium: false, membershipTier: 'green' });
});
afterEach(() => {
  (config as any).nodeEnv = saved.nodeEnv;
  (config as any).stripeSecretKey = saved.key;
  (config as any).paidCheckoutEnabled = saved.enabled;
});

test('Platinum checkout is refused from the iOS app whatever the key', async () => {
  (config as any).stripeSecretKey = 'sk_live_x';
  await assert.rejects(() => createCaller(ctx('ios')).subscription.createCheckout(), { code: 'FORBIDDEN' });
});

test('Platinum checkout is refused in production on a Stripe test key', async () => {
  (config as any).nodeEnv = 'production';
  (config as any).stripeSecretKey = 'sk_test_x';
  await assert.rejects(() => createCaller(ctx('web')).subscription.createCheckout(), { code: 'PRECONDITION_FAILED', message: /not live/ });
});

test('valet tips are refused in production on a Stripe test key', async () => {
  (config as any).nodeEnv = 'production';
  (config as any).stripeSecretKey = 'sk_test_x';
  await assert.rejects(() => createCaller(ctx('web')).tips.createTip({ valetId: 'v1', amount: 5 }), { code: 'PRECONDITION_FAILED' });
});

test('the kill switch refuses Platinum checkout in any environment', async () => {
  (config as any).stripeSecretKey = 'sk_test_x';
  (config as any).paidCheckoutEnabled = false;
  await assert.rejects(() => createCaller(ctx('web')).subscription.createCheckout(), { code: 'PRECONDITION_FAILED' });
});

test('the native URLSession agent and the declared header both read as iOS', () => {
  assert.equal(clientPlatformOf({ 'user-agent': 'Bytspot/1.1 CFNetwork/1494.0.7 Darwin/23.4.0' }), 'ios');
  assert.equal(clientPlatformOf({ 'x-bytspot-client': 'ios' }), 'ios');
  assert.equal(clientPlatformOf({ 'user-agent': 'Mozilla/5.0 (Macintosh)' }), 'unknown');
});

test('vendor ticket checkout is refused in production on a Stripe test key before reading the ticket', async (t) => {
  const { stripeHandle } = await import('../vendor/payout');
  const { startTicketCheckout, PaymentsUnavailable } = await import('../vendor/tickets');
  t.mock.method(stripeHandle, 'client', () => ({}) as any);
  (db.vendorTicket as any).findFirst = async () => { throw new Error('must not read the ticket'); };
  (config as any).nodeEnv = 'production';
  (config as any).stripeSecretKey = 'sk_test_x';
  await assert.rejects(() => startTicketCheckout({ ticketId: 't1', userId: 'u1' }), PaymentsUnavailable);
});
