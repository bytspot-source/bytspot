/**
 * Shared test helpers — creates tRPC callers with optional auth context.
 */
import { createCallerFactory } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import type { AuthPayload } from '../middleware/auth';

const factory = createCallerFactory(appRouter);

/** Create an unauthenticated caller */
export function createPublicCaller() {
  const ctx: Context = { user: null };
  return factory(ctx);
}

/** Create the internal caller used by the signed Stripe webhook REST dispatcher. */
export function createStripeWebhookCaller() {
  const ctx: Context = { user: null, internal: { stripeWebhook: true } };
  return factory(ctx);
}

/** Create an authenticated caller with the given userId + email */
export function createAuthenticatedCaller(
  userId = 'test-user-id',
  email = 'test@bytspot.com',
  claims: Partial<AuthPayload> = {},
  options: { authUserExists?: boolean } = { authUserExists: true },
) {
  const ctx: Context = {
    user: { userId, email, ...claims },
    ...(options.authUserExists === false ? {} : { authUserExists: true as const }),
  };
  return factory(ctx);
}

