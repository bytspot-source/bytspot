import type Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { stripeHandle } from '../vendor/payout';

/**
 * Cards a member keeps on file for checkout. Stripe hosts the card form and
 * holds every card; this API only reads back brand, last four and expiry, and
 * changes which saved card is the default.
 */

export const PAYMENT_SETUP_RETURN_PATH = '/payments/setup/return';
export const PAYMENT_SETUP_CANCEL_PATH = '/payments/setup/cancelled';

export interface SavedPaymentMethodView {
  id: string;
  type: 'card';
  brand: string | null;
  last4: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
  isDefault: boolean;
}

const PAYMENT_METHOD_ID = /^pm_[A-Za-z0-9_]{1,250}$/;
const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9_]{1,250}$/;

export function isPaymentMethodId(value: string): boolean {
  return PAYMENT_METHOD_ID.test(value);
}

export function isCheckoutSessionId(value: string): boolean {
  return CHECKOUT_SESSION_ID.test(value);
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

export function paymentMethodView(method: Stripe.PaymentMethod, defaultId: string | null): SavedPaymentMethodView {
  const card = method.card;
  return {
    id: method.id,
    type: 'card',
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    expiryMonth: card?.exp_month ? String(card.exp_month).padStart(2, '0') : null,
    expiryYear: card?.exp_year ? String(card.exp_year) : null,
    isDefault: method.id === defaultId,
  };
}

async function storedCustomerId(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
  return user?.stripeCustomerId ?? null;
}

/** The member's Stripe customer, created on first use. */
export async function ensureStripeCustomer(userId: string, stripe: Stripe): Promise<string> {
  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { email: true, stripeCustomerId: true } });
  if (!user) throw new Error('Account not found.');
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe.customers.create({ email: user.email, metadata: { userId } }, { idempotencyKey: `stripe-customer:${userId}` });
  // A concurrent first use may have stored its customer already; that one wins.
  await db.user.updateMany({ where: { id: userId, stripeCustomerId: null }, data: { stripeCustomerId: customer.id } });
  return (await storedCustomerId(userId)) ?? customer.id;
}

async function defaultMethodId(stripe: Stripe, customerId: string): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) return null;
  return idOf((customer as Stripe.Customer).invoice_settings?.default_payment_method);
}

export async function listSavedPaymentMethods(userId: string, stripe: Stripe | null = stripeHandle.client()): Promise<SavedPaymentMethodView[]> {
  const customerId = await storedCustomerId(userId);
  if (!stripe || !customerId) return [];
  const [methods, defaultId] = await Promise.all([
    stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 20 }),
    defaultMethodId(stripe, customerId),
  ]);
  return methods.data.map((method) => paymentMethodView(method, defaultId));
}

/** A Stripe-hosted page that saves a card without charging it. */
export async function createPaymentSetupSession(userId: string, stripe: Stripe | null = stripeHandle.client()): Promise<{ url: string } | null> {
  if (!stripe) return null;
  const customer = await ensureStripeCustomer(userId, stripe);
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer,
    currency: 'usd',
    payment_method_types: ['card'],
    metadata: { kind: 'saved-payment-method', userId },
    success_url: `${config.publicApiUrl}${PAYMENT_SETUP_RETURN_PATH}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.publicApiUrl}${PAYMENT_SETUP_CANCEL_PATH}`,
  });
  return session.url ? { url: session.url } : null;
}

/** The card, only when it is attached to this member's customer. */
async function ownedMethod(userId: string, paymentMethodId: string, stripe: Stripe): Promise<{ customerId: string; method: Stripe.PaymentMethod } | null> {
  if (!isPaymentMethodId(paymentMethodId)) return null;
  const customerId = await storedCustomerId(userId);
  if (!customerId) return null;
  try {
    const method = await stripe.paymentMethods.retrieve(paymentMethodId);
    return idOf(method.customer) === customerId ? { customerId, method } : null;
  } catch {
    return null;
  }
}

export async function setDefaultPaymentMethod(userId: string, paymentMethodId: string, stripe: Stripe | null = stripeHandle.client()): Promise<boolean> {
  if (!stripe) return false;
  const owned = await ownedMethod(userId, paymentMethodId, stripe);
  if (!owned) return false;
  await stripe.customers.update(owned.customerId, { invoice_settings: { default_payment_method: owned.method.id } });
  return true;
}

export async function removePaymentMethod(userId: string, paymentMethodId: string, stripe: Stripe | null = stripeHandle.client()): Promise<boolean> {
  if (!stripe) return false;
  const owned = await ownedMethod(userId, paymentMethodId, stripe);
  if (!owned) return false;
  await stripe.paymentMethods.detach(owned.method.id);
  return true;
}

/**
 * Runs when Stripe sends the member back from the setup page. The member asked
 * to keep this card, so it is offered again at checkout, and it becomes the
 * default when there is none yet.
 */
export async function completePaymentSetup(sessionId: string, stripe: Stripe | null = stripeHandle.client()): Promise<boolean> {
  if (!stripe || !isCheckoutSessionId(sessionId)) return false;
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['setup_intent'] });
  const customerId = idOf(session.customer);
  const intent = session.setup_intent && typeof session.setup_intent !== 'string' ? session.setup_intent : null;
  const methodId = idOf(intent?.payment_method);
  if (session.mode !== 'setup' || session.metadata?.kind !== 'saved-payment-method' || intent?.status !== 'succeeded' || !customerId || !methodId) return false;
  await stripe.paymentMethods.update(methodId, { allow_redisplay: 'always' });
  if (!(await defaultMethodId(stripe, customerId))) {
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: methodId } });
  }
  return true;
}
