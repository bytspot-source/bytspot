import { db } from '../lib/db';
import { hashEmail } from '../lib/contactHash';

/**
 * Recompute the salted identity hashes for a member's own verified
 * identifiers. These rows let contact sync answer "is this contact on
 * Bytspot?" without the other member syncing their own address book first.
 * Only salted SHA-256 digests are stored — never the raw identifiers.
 *
 * Only the account email is hashed: it is proven by the auth flow (password
 * signup or Apple/Google provider). The profile phone is deliberately
 * excluded — it is free-form user input, and hashing an unverified number
 * would let a member claim someone else's number and impersonate them in
 * contact discovery. Add `kind: 'phone'` only once a phone-verification
 * flow records ownership.
 *
 * Best-effort by design: identity hashes are a discovery optimization, so
 * failures must never break signup/profile flows. Callers fire-and-forget.
 */
export async function refreshUserIdentityHashes(
  userId: string,
  identifiers: { email?: string | null },
): Promise<void> {
  try {
    const rows: { hashedIdentity: string; kind: string }[] = [];
    const emailHash = hashEmail(identifiers.email);
    if (emailHash) rows.push({ hashedIdentity: emailHash, kind: 'email' });

    await db.$transaction([
      db.userIdentityHash.deleteMany({
        where: { userId, hashedIdentity: { notIn: rows.map((row) => row.hashedIdentity) } },
      }),
      db.userIdentityHash.createMany({
        data: rows.map((row) => ({ userId, ...row })),
        skipDuplicates: true,
      }),
    ]);
  } catch {
    // Non-fatal: suggestions degrade gracefully until the next refresh.
  }
}

/**
 * One-shot startup backfill: compute identity hashes for members that do not
 * have any yet (accounts created before this feature shipped). Batched and
 * best-effort — a failure only delays discovery until the next restart.
 *
 * Each pass re-queries the first batch of unprocessed members (no cursor:
 * processing removes rows from the `none` predicate, so cursoring over it
 * could skip members). Inserts use createMany with skipDuplicates, so
 * concurrent instances running the same backfill converge safely.
 */
export async function backfillUserIdentityHashes(batchSize = 500): Promise<void> {
  const startedAt = Date.now();
  let processed = 0;
  try {
    for (;;) {
      const users = await db.user.findMany({
        where: { identityHashes: { none: {} } },
        select: { id: true, email: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (users.length === 0) break;
      const rows = users.flatMap((user) => {
        const emailHash = hashEmail(user.email);
        return emailHash ? [{ userId: user.id, hashedIdentity: emailHash, kind: 'email' }] : [];
      });
      if (rows.length > 0) {
        await db.userIdentityHash.createMany({ data: rows, skipDuplicates: true });
      }
      processed += users.length;
      // Members whose email produces no hash would repeat forever under the
      // `none` predicate — stop once a batch adds nothing new.
      if (rows.length === 0) break;
      if (users.length < batchSize) break;
    }
    if (processed > 0) {
      console.log(`[identity-hashes] backfill complete: ${processed} member(s) in ${Date.now() - startedAt}ms`);
    }
  } catch (error) {
    console.error(`[identity-hashes] backfill failed after ${processed} member(s):`, error instanceof Error ? error.message : error);
  }
}
