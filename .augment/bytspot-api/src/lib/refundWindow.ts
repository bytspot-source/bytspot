/**
 * A guest may cancel a paid ticket or table and be refunded in full until this
 * long before it starts. Bytspot keeps none of the price and absorbs Stripe's
 * processing fee, which Stripe does not return on a refund.
 */
export const GUEST_REFUND_CUTOFF_MS = 24 * 60 * 60 * 1000;

/** The last moment a guest can cancel something that starts at `startsAt`. */
export function refundableUntil(startsAt: Date): Date {
  return new Date(startsAt.getTime() - GUEST_REFUND_CUTOFF_MS);
}
