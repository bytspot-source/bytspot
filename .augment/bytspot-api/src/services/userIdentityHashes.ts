import { db } from '../lib/db';
import { keyContactHash, storedEmailHash } from '../lib/contactHash';

/**
 * Recompute the salted identity hashes for a member's own verified
 * identifiers. These rows let contact sync answer "is this contact on
 * Bytspot?" without the other member syncing their own address book first.
 * Only salted SHA-256 digests are stored — never the raw identifiers.
 *
 * The account email is hashed only once it is verified (an email code or an
 * Apple/Google sign-in). Callers must not pass an unverified email: password
 * signup alone does not prove ownership. Every extra email (`UserEmail`) is
 * hashed too: a row exists only once its code was entered. The profile phone is deliberately
 * excluded — it is free-form user input, and hashing an unverified number
 * would let a member claim someone else's number and impersonate them in
 * contact discovery. Add `kind: 'phone'` only once a phone-verification
 * flow records ownership.
 *
 * Best-effort by design: identity hashes are a discovery optimization, so
 * failures must never break signup/profile flows. Callers fire-and-forget.
 */
export type IdentityHashDatabase = Pick<typeof db, '$transaction' | 'userIdentityHash' | 'userEmail'>;

export async function refreshUserIdentityHashes(
  userId: string,
  identifiers: { email?: string | null },
  database: IdentityHashDatabase = db,
): Promise<void> {
  try {
    const rows: { hashedIdentity: string; kind: string }[] = [];
    const extras = await database.userEmail.findMany({ where: { userId }, select: { email: true } });
    for (const email of [identifiers.email, ...extras.map((extra) => extra.email)]) {
      const emailHash = storedEmailHash(email);
      if (emailHash && !rows.some((row) => row.hashedIdentity === emailHash)) rows.push({ hashedIdentity: emailHash, kind: 'email' });
    }

    await database.$transaction([
      database.userIdentityHash.deleteMany({
        where: { userId, hashedIdentity: { notIn: rows.map((row) => row.hashedIdentity) } },
      }),
      database.userIdentityHash.createMany({
        data: rows.map((row) => ({ userId, ...row })),
        skipDuplicates: true,
      }),
    ]);
  } catch (error) {
    // Non-fatal: suggestions degrade gracefully until the next refresh. Logged
    // because a persistent failure degrades silently forever otherwise.
    console.warn('[identity-hashes] refresh failed:', error instanceof Error ? error.message : error);
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
        where: { identityHashes: { none: {} }, emailVerifiedAt: { not: null } },
        select: { id: true, email: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      });
      if (users.length === 0) break;
      const rows = users.flatMap((user) => {
        const emailHash = storedEmailHash(user.email);
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

export type RekeyDatabase = Pick<typeof db, '$transaction' | 'contactHash' | 'userIdentityHash'>;

/**
 * One-shot startup pass: rows written before CONTACT_HASH_PEPPER hold the
 * client's salted hash, which can be reversed by trying every phone number.
 * Each is replaced by its keyed form. The result equals what a fresh sync
 * would write, so matching is unchanged. Rows are deleted and re-created in
 * one transaction with skipDuplicates, so a row that a concurrent sync already
 * wrote, or a second instance running the same pass, cannot collide.
 */
export async function rekeyStoredContactHashes(batchSize = 500, database: RekeyDatabase = db): Promise<{ contacts: number; identities: number }> {
  const done = { contacts: 0, identities: 0 };
  try {
    for (;;) {
      const rows = await database.contactHash.findMany({
        where: { keyed: false }, select: { id: true, userId: true, hashedContact: true, createdAt: true }, orderBy: { id: 'asc' }, take: batchSize,
      });
      if (rows.length === 0) break;
      await database.$transaction([
        database.contactHash.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
        database.contactHash.createMany({
          data: rows.map((row) => ({ userId: row.userId, hashedContact: keyContactHash(row.hashedContact), createdAt: row.createdAt, keyed: true })),
          skipDuplicates: true,
        }),
      ]);
      done.contacts += rows.length;
      if (rows.length < batchSize) break;
    }
    for (;;) {
      const rows = await database.userIdentityHash.findMany({
        where: { keyed: false }, select: { id: true, userId: true, hashedIdentity: true, kind: true, createdAt: true }, orderBy: { id: 'asc' }, take: batchSize,
      });
      if (rows.length === 0) break;
      await database.$transaction([
        database.userIdentityHash.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } }),
        database.userIdentityHash.createMany({
          data: rows.map((row) => ({ userId: row.userId, hashedIdentity: keyContactHash(row.hashedIdentity), kind: row.kind, createdAt: row.createdAt, keyed: true })),
          skipDuplicates: true,
        }),
      ]);
      done.identities += rows.length;
      if (rows.length < batchSize) break;
    }
    if (done.contacts + done.identities > 0) {
      console.log(`[contact-hashes] rekeyed ${done.contacts} contact hash(es) and ${done.identities} identity hash(es)`);
    }
  } catch (error) {
    console.error('[contact-hashes] rekey failed:', error instanceof Error ? error.message : error);
  }
  return done;
}
