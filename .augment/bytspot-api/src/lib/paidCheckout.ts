import { TRPCError } from '@trpc/server';
import { config } from '../config';

/**
 * REA review 2026-11-10, X5. Production must never hand out a paid credential
 * (party pass, session, vendor ticket, tip or Platinum) for a Stripe charge
 * made in test mode, because Stripe's public test card completes a test-mode
 * Checkout. While the configured secret key is a test (or restricted test)
 * key, production refuses to create any paid Checkout session or payment
 * intent. `PAID_CHECKOUT_ENABLED=false` closes every paid flow on top of that.
 *
 * Fails closed: an unrecognised key prefix in production is treated as unsafe.
 */
export interface PaidCheckoutEnv {
  nodeEnv: string;
  stripeSecretKey: string;
  paidCheckoutEnabled: boolean;
}

export const PAID_CHECKOUT_BLOCKED_MESSAGE = 'Payments are not live yet. Nothing was charged.';

export function stripeKeyMode(key: string): 'live' | 'test' | 'none' | 'unknown' {
  if (!key) return 'none';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  return 'unknown';
}

/** Why paid checkout is closed, or null when it may proceed. */
export function paidCheckoutBlockReason(env: PaidCheckoutEnv = currentEnv()): string | null {
  if (!env.paidCheckoutEnabled) return 'paid checkout is switched off (PAID_CHECKOUT_ENABLED=false)';
  if (env.nodeEnv !== 'production') return null;
  const mode = stripeKeyMode(env.stripeSecretKey);
  if (mode === 'test') return 'production is configured with a Stripe test key';
  if (mode === 'unknown') return 'production Stripe key is not a recognised live key';
  return null;
}

export class PaidCheckoutBlocked extends Error {
  constructor(readonly reason: string) {
    super(PAID_CHECKOUT_BLOCKED_MESSAGE);
  }
}

/** Throws PaidCheckoutBlocked (never the key) when paid checkout is closed. */
export function assertPaidCheckoutAllowed(env: PaidCheckoutEnv = currentEnv()): void {
  const reason = paidCheckoutBlockReason(env);
  if (reason) {
    console.warn(`[paid-checkout] refused: ${reason}`);
    throw new PaidCheckoutBlocked(reason);
  }
}

function currentEnv(): PaidCheckoutEnv {
  return { nodeEnv: config.nodeEnv, stripeSecretKey: config.stripeSecretKey, paidCheckoutEnabled: config.paidCheckoutEnabled };
}

/** tRPC form: PRECONDITION_FAILED with a message that names no key. */
export function assertPaidCheckoutAllowedForTrpc(env?: PaidCheckoutEnv): void {
  try {
    assertPaidCheckoutAllowed(env);
  } catch (error) {
    if (error instanceof PaidCheckoutBlocked) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: PAID_CHECKOUT_BLOCKED_MESSAGE });
    throw error;
  }
}
