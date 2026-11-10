import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { config } from '../config';
import { db } from '../lib/db';
import { createCallerFactory } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import {
  completePaymentSetup,
  createPaymentSetupSession,
  ensureStripeCustomer,
  listSavedPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod,
} from './savedPaymentMethods';

const user = db.user as any;
const original = { findUnique: user.findUnique, findFirst: user.findFirst, updateMany: user.updateMany };
let stored: { email: string; stripeCustomerId: string | null };

function card(id: string, customer: string | null, over: Record<string, unknown> = {}) {
  return { id, customer, card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2031 }, ...over };
}

function fakeStripe(over: { defaultMethod?: string | null; methods?: any[]; session?: any } = {}) {
  const calls: Record<string, any[]> = {};
  const record = (name: string, value: any) => { (calls[name] ??= []).push(value); };
  const methods = over.methods ?? [card('pm_mine', 'cus_mine')];
  const stripe = {
    customers: {
      create: async (params: any, options: any) => { record('customers.create', { params, options }); return { id: 'cus_new' }; },
      retrieve: async () => ({ id: 'cus_mine', invoice_settings: { default_payment_method: over.defaultMethod ?? null } }),
      update: async (id: string, params: any) => { record('customers.update', { id, params }); return { id }; },
    },
    paymentMethods: {
      list: async (params: any) => { record('paymentMethods.list', params); return { data: methods }; },
      retrieve: async (id: string) => {
        const found = methods.find((method) => method.id === id);
        if (!found) throw new Error('No such payment method');
        return found;
      },
      update: async (id: string, params: any) => { record('paymentMethods.update', { id, params }); return { id }; },
      detach: async (id: string) => { record('paymentMethods.detach', id); return { id }; },
    },
    checkout: {
      sessions: {
        create: async (params: any) => { record('sessions.create', params); return { url: 'https://checkout.stripe.com/c/pay/cs_test_setup' }; },
        retrieve: async (id: string, params: any) => { record('sessions.retrieve', { id, params }); return over.session; },
      },
    },
  };
  return { stripe: stripe as any, calls };
}

beforeEach(() => {
  stored = { email: 'member@bytspot.test', stripeCustomerId: 'cus_mine' };
  user.findUnique = async () => ({ stripeCustomerId: stored.stripeCustomerId });
  user.findFirst = async () => ({ ...stored });
  user.updateMany = async ({ where, data }: any) => {
    if (where.stripeCustomerId !== null || stored.stripeCustomerId !== null) return { count: 0 };
    stored.stripeCustomerId = data.stripeCustomerId;
    return { count: 1 };
  };
});

afterEach(() => {
  Object.assign(user, original);
});

test('saved cards read back brand, last four, expiry and which one is the default', async () => {
  const { stripe, calls } = fakeStripe({ defaultMethod: 'pm_mine', methods: [card('pm_mine', 'cus_mine'), card('pm_other', 'cus_mine', { card: { brand: 'amex', last4: '0005', exp_month: 12, exp_year: 2030 } })] });
  assert.deepEqual(await listSavedPaymentMethods('user-1', stripe), [
    { id: 'pm_mine', type: 'card', brand: 'visa', last4: '4242', expiryMonth: '04', expiryYear: '2031', isDefault: true },
    { id: 'pm_other', type: 'card', brand: 'amex', last4: '0005', expiryMonth: '12', expiryYear: '2030', isDefault: false },
  ]);
  assert.equal(calls['paymentMethods.list'][0].customer, 'cus_mine');
});

test('a member without a Stripe customer, or without Stripe, has no saved cards', async () => {
  stored.stripeCustomerId = null;
  const { stripe, calls } = fakeStripe();
  assert.deepEqual(await listSavedPaymentMethods('user-1', stripe), []);
  assert.equal(calls['paymentMethods.list'], undefined);
  stored.stripeCustomerId = 'cus_mine';
  assert.deepEqual(await listSavedPaymentMethods('user-1', null), []);
});

test('card setup creates the customer once and returns to the server, never a client path', async () => {
  stored.stripeCustomerId = null;
  const { stripe, calls } = fakeStripe();
  assert.deepEqual(await createPaymentSetupSession('user-1', stripe), { url: 'https://checkout.stripe.com/c/pay/cs_test_setup' });
  assert.equal(calls['customers.create'][0].options.idempotencyKey, 'stripe-customer:user-1');
  const session = calls['sessions.create'][0];
  assert.equal(session.mode, 'setup');
  assert.equal(session.customer, 'cus_new');
  assert.equal(session.metadata.kind, 'saved-payment-method');
  assert.match(session.success_url, /\/payments\/setup\/return\?session_id=\{CHECKOUT_SESSION_ID\}$/);
  assert.match(session.cancel_url, /\/payments\/setup\/cancelled$/);

  assert.equal(await ensureStripeCustomer('user-1', stripe), 'cus_new');
  assert.equal(calls['customers.create'].length, 1, 'an existing customer is reused');
  assert.equal(await createPaymentSetupSession('user-1', null), null);
});

test('only a card attached to this member can be made default or removed', async () => {
  const { stripe, calls } = fakeStripe({ methods: [card('pm_mine', 'cus_mine'), card('pm_theirs', 'cus_someone_else')] });
  assert.equal(await setDefaultPaymentMethod('user-1', 'pm_theirs', stripe), false);
  assert.equal(await removePaymentMethod('user-1', 'pm_theirs', stripe), false);
  assert.equal(await removePaymentMethod('user-1', 'pm_missing', stripe), false);
  assert.equal(await removePaymentMethod('user-1', 'not-a-card-id', stripe), false);
  assert.equal(calls['customers.update'], undefined);
  assert.equal(calls['paymentMethods.detach'], undefined);

  assert.equal(await setDefaultPaymentMethod('user-1', 'pm_mine', stripe), true);
  assert.deepEqual(calls['customers.update'][0], { id: 'cus_mine', params: { invoice_settings: { default_payment_method: 'pm_mine' } } });
  assert.equal(await removePaymentMethod('user-1', 'pm_mine', stripe), true);
  assert.deepEqual(calls['paymentMethods.detach'], ['pm_mine']);

  stored.stripeCustomerId = null;
  assert.equal(await removePaymentMethod('user-1', 'pm_mine', stripe), false);
});

test('returning from setup offers the card again at checkout and makes it the default when there is none', async () => {
  const session = { mode: 'setup', customer: 'cus_mine', metadata: { kind: 'saved-payment-method' }, setup_intent: { status: 'succeeded', payment_method: 'pm_new' } };
  const first = fakeStripe({ session, defaultMethod: null });
  assert.equal(await completePaymentSetup('cs_test_abc123', first.stripe), true);
  assert.deepEqual(first.calls['paymentMethods.update'], [{ id: 'pm_new', params: { allow_redisplay: 'always' } }]);
  assert.deepEqual(first.calls['customers.update'], [{ id: 'cus_mine', params: { invoice_settings: { default_payment_method: 'pm_new' } } }]);

  const second = fakeStripe({ session, defaultMethod: 'pm_old' });
  assert.equal(await completePaymentSetup('cs_test_abc123', second.stripe), true);
  assert.equal(second.calls['customers.update'], undefined, 'an existing default is kept');
});

test('a return that is not a finished card setup changes nothing', async () => {
  const unfinished = fakeStripe({ session: { mode: 'setup', customer: 'cus_mine', metadata: { kind: 'saved-payment-method' }, setup_intent: { status: 'requires_payment_method', payment_method: null } } });
  assert.equal(await completePaymentSetup('cs_test_abc123', unfinished.stripe), false);
  const payment = fakeStripe({ session: { mode: 'payment', customer: 'cus_mine', metadata: { kind: 'party-ticket' }, setup_intent: null } });
  assert.equal(await completePaymentSetup('cs_test_abc123', payment.stripe), false);
  const forged = fakeStripe();
  assert.equal(await completePaymentSetup('../../v1/customers', forged.stripe), false);
  assert.equal(forged.calls['sessions.retrieve'], undefined);
  for (const fake of [unfinished, payment]) {
    assert.equal(fake.calls['paymentMethods.update'], undefined);
    assert.equal(fake.calls['customers.update'], undefined);
  }
});

test('the app\'s payments routes are mounted and refuse what they cannot do', async () => {
  const key = config.stripeSecretKey;
  (config as any).stripeSecretKey = '';
  try {
    const context: Context = { user: { userId: 'payments-user', email: 'payments@bytspot.test' }, clientRateLimitKey: 'test-payments-client' };
    const caller = createCallerFactory(appRouter)(context);
    assert.deepEqual(await caller.payments.listMethods(), []);
    await assert.rejects(() => caller.payments.setupSession({ successPath: '/profile/payment', cancelPath: '/profile/payment' }), { code: 'PRECONDITION_FAILED' });
    await assert.rejects(() => caller.payments.setDefaultMethod({ paymentMethodId: 'pm_mine' }), { code: 'NOT_FOUND' });
    await assert.rejects(() => caller.payments.removeMethod({ paymentMethodId: 'pm_mine' }), { code: 'NOT_FOUND' });
  } finally {
    (config as any).stripeSecretKey = key;
  }
});
