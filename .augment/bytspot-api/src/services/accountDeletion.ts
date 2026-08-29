import type Redis from 'ioredis';
import { db } from '../lib/db';
import { refundHostedPartiesForPurge } from './partyCheckoutSettlement';
import { getRedis } from '../lib/redis';

/**
 * Grace period between a deletion request and irreversible purge. Long enough
 * that an accidental or coerced deletion is recoverable, short enough to stay
 * a credible deletion promise.
 */
export const DELETION_GRACE_DAYS = 30;
const GRACE_MS = DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** Redis key holding user ids whose sessions are revoked pending purge. */
const REVOKED_KEY = 'account:pending-deletion';

export function purgeDateFrom(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + GRACE_MS);
}

export function isWithinGracePeriod(purgeAfter: Date | null | undefined, now = new Date()): boolean {
  return Boolean(purgeAfter && purgeAfter.getTime() > now.getTime());
}

export type SignInDeletionOutcome = 'none' | 'restored' | 'purge-pending';

/**
 * Applies deletion policy to a successful sign-in, whatever the credential.
 * Signing in is the owner proving control, so it cancels a pending deletion
 * rather than locking them out of their own recovery. Every auth path must
 * call this: a member who deleted their account and signs back in with Apple
 * must be restored exactly as an email member is, or the 30-day promise is
 * only true for one credential type.
 *
 * Returns 'purge-pending' when the grace period has elapsed; the caller must
 * then refuse the sign-in, because the row is awaiting irreversible purge.
 */
export async function applyDeletionPolicyOnSignIn(userId: string, now = new Date()): Promise<SignInDeletionOutcome> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { deletedAt: true, purgeAfter: true } });
  if (!user?.deletedAt) return 'none';
  if (!isWithinGracePeriod(user.purgeAfter, now)) return 'purge-pending';

  await db.user.update({
    where: { id: userId },
    data: { deletedAt: null, purgeAfter: null, deletionReason: null },
  });
  await restoreSessions(userId);
  return 'restored';
}

/**
 * Revoke live sessions for a deleted account.
 *
 * Access tokens are valid for days, so clearing the DB flag alone would leave
 * a deleted account usable until its JWT expired. The revocation set is keyed
 * by user id and expires with the grace period, after which the row is gone.
 */
export async function revokeSessions(userId: string, redis: Redis | null = getRedis()): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(`${REVOKED_KEY}:${userId}`, '1', 'PX', GRACE_MS);
  } catch {
    // Redis unavailability must not block the deletion itself; the DB flag is
    // authoritative and every auth entry point re-checks it.
  }
}

export async function restoreSessions(userId: string, redis: Redis | null = getRedis()): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`${REVOKED_KEY}:${userId}`);
  } catch {
    /* see revokeSessions */
  }
}

export async function isSessionRevoked(userId: string, redis: Redis | null = getRedis()): Promise<boolean> {
  if (!redis) return false;
  try {
    return (await redis.exists(`${REVOKED_KEY}:${userId}`)) === 1;
  } catch {
    // Fail open: a Redis outage must not lock out the entire member base.
    // The DB flag still blocks sign-in and the purge job still runs.
    return false;
  }
}

/**
 * Irreversibly remove accounts whose grace period has elapsed. Returns the
 * number of rows purged, and the number held back, so the cron response is
 * observable.
 *
 * A purge no longer destroys the payment ledger: PartyCheckout detaches from
 * the member and the party instead of cascading, so a refund stays possible
 * after erasure. What a purge must not do is quietly keep a guest's money for
 * an event that will never happen, so a host's parties are cancelled and their
 * sales refunded first. An account whose parties cannot be settled is held
 * back for an operator rather than purged mid-refund.
 */
export async function purgeExpiredAccounts(now = new Date()): Promise<{ purged: number; heldForOwedMoney: number }> {
  const due = await db.user.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true },
  });
  if (due.length === 0) return { purged: 0, heldForOwedMoney: 0 };

  let purged = 0;
  let heldForOwedMoney = 0;
  for (const { id } of due) {
    const { settled } = await refundHostedPartiesForPurge(id);
    if (!settled) {
      console.warn('[account-purge] held back: hosted Party sales could not be refunded', { userId: id });
      heldForOwedMoney += 1;
      continue;
    }
    // Relations cascade at the schema level; identity hashes are removed first
    // so a purged member can never resurface in contact discovery.
    await db.userIdentityHash.deleteMany({ where: { userId: id } });
    await db.user.delete({ where: { id } });
    purged += 1;
  }
  return { purged, heldForOwedMoney };
}
