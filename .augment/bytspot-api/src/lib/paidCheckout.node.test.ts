import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPaidCheckoutAllowed, PaidCheckoutBlocked, paidCheckoutBlockReason, stripeKeyMode } from './paidCheckout';

const prod = (stripeSecretKey: string, paidCheckoutEnabled = true) => ({ nodeEnv: 'production', stripeSecretKey, paidCheckoutEnabled });

test('stripe key mode is read from the prefix only', () => {
  assert.equal(stripeKeyMode('sk_test_abc'), 'test');
  assert.equal(stripeKeyMode('rk_test_abc'), 'test');
  assert.equal(stripeKeyMode('sk_live_abc'), 'live');
  assert.equal(stripeKeyMode(''), 'none');
  assert.equal(stripeKeyMode('pk_live_abc'), 'unknown');
});

test('production with a test key refuses paid checkout', () => {
  assert.match(paidCheckoutBlockReason(prod('sk_test_x'))!, /test key/);
  assert.match(paidCheckoutBlockReason(prod('rk_test_x'))!, /test key/);
  assert.throws(() => assertPaidCheckoutAllowed(prod('sk_test_x')), PaidCheckoutBlocked);
});

test('production fails closed on an unrecognised key', () => {
  assert.ok(paidCheckoutBlockReason(prod('pk_live_x')));
});

test('production with a live key is allowed', () => {
  assert.equal(paidCheckoutBlockReason(prod('sk_live_x')), null);
});

test('the kill switch closes every environment', () => {
  assert.ok(paidCheckoutBlockReason(prod('sk_live_x', false)));
  assert.ok(paidCheckoutBlockReason({ nodeEnv: 'development', stripeSecretKey: 'sk_test_x', paidCheckoutEnabled: false }));
});

test('development and test runs may use test keys', () => {
  assert.equal(paidCheckoutBlockReason({ nodeEnv: 'development', stripeSecretKey: 'sk_test_x', paidCheckoutEnabled: true }), null);
});

test('the error never carries the key', () => {
  try { assertPaidCheckoutAllowed(prod('sk_test_SECRETVALUE')); } catch (error) {
    assert.ok(!String((error as Error).message).includes('SECRETVALUE'));
    assert.ok(!String((error as PaidCheckoutBlocked).reason).includes('SECRETVALUE'));
  }
});
