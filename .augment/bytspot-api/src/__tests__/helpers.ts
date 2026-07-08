/**
 * Shared test helpers — creates tRPC callers with optional auth context.
 */
import { createCallerFactory } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';

const factory = createCallerFactory(appRouter);

/** Create an unauthenticated caller */
export function createPublicCaller() {
  const ctx: Context = { user: null };
  return factory(ctx);
}

/** Create an authenticated caller with the given userId + email */
export function createAuthenticatedCaller(userId = 'test-user-id', email = 'test@bytspot.com') {
  const ctx: Context = { user: { userId, email } };
  return factory(ctx);
}

/** Create an internal caller representing a verified Stripe webhook dispatch. */
export function createStripeWebhookCaller() {
  const ctx: Context = { user: null, internal: { stripeWebhook: true } };
  return factory(ctx);
}

