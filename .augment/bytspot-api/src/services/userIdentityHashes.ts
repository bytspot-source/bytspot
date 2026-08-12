import { db } from '../lib/db';
import { hashEmail, hashPhone } from '../lib/contactHash';

/**
 * Recompute the salted identity hashes for a member's own verified
 * identifiers (account email + profile phone). These rows let contact sync
 * answer "is this contact on Bytspot?" without the other member syncing
 * their own address book first. Only salted SHA-256 digests are stored —
 * never the raw identifiers themselves.
 *
 * Best-effort by design: identity hashes are a discovery optimization, so
 * failures must never break signup/profile flows. Callers fire-and-forget.
 */
export async function refreshUserIdentityHashes(
  userId: string,
  identifiers: { email?: string | null; phone?: string | null },
): Promise<void> {
  try {
    const rows: { hashedIdentity: string; kind: string }[] = [];
    const emailHash = hashEmail(identifiers.email);
    if (emailHash) rows.push({ hashedIdentity: emailHash, kind: 'email' });
    const phoneHash = hashPhone(identifiers.phone);
    if (phoneHash) rows.push({ hashedIdentity: phoneHash, kind: 'phone' });

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
 */
export async function backfillUserIdentityHashes(batchSize = 500): Promise<void> {
  try {
    let cursor: string | undefined;
    for (;;) {
      const users = await db.user.findMany({
        where: { identityHashes: { none: {} } },
        select: { id: true, email: true, phone: true },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (users.length === 0) return;
      for (const user of users) {
        await refreshUserIdentityHashes(user.id, { email: user.email, phone: user.phone });
      }
      cursor = users[users.length - 1].id;
      if (users.length < batchSize) return;
    }
  } catch {
    // Non-fatal: retried on the next server start.
  }
}
