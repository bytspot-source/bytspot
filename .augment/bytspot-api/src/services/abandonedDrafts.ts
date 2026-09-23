import { db } from '../lib/db';
import { ABANDONED_DRAFT_TTL_MS } from '../trpc/partyRouter';

/**
 * Remove Host Studio drafts nobody has touched inside the TTL.
 *
 * Scope is deliberately narrow. Only `status = 'draft'` rows are eligible: a
 * published party owns guest lists and payment records, which is exactly why
 * `events.drafts.delete` refuses to remove one once money is in motion, and no
 * unattended job may do what a host is forbidden from doing by hand.
 *
 * The guest and checkout guards below are defence in depth rather than an
 * expected case — guests arrive through a share link, which a draft has never
 * been issued — so a draft that somehow holds either is left alone for a human
 * to look at instead of being swept silently.
 */
export async function purgeAbandonedPartyDrafts(now = new Date()): Promise<{ purged: number }> {
  const cutoff = new Date(now.getTime() - ABANDONED_DRAFT_TTL_MS);
  const due = await db.party.findMany({
    where: {
      status: 'draft',
      updatedAt: { lte: cutoff },
      guests: { none: {} },
      checkouts: { none: {} },
    },
    select: { id: true },
  });
  if (due.length === 0) return { purged: 0 };

  // Re-assert the full predicate in the delete itself: a host can return to a
  // draft between the read and the write, and the row must survive if they do.
  const deleted = await db.party.deleteMany({
    where: {
      id: { in: due.map((draft) => draft.id) },
      status: 'draft',
      updatedAt: { lte: cutoff },
      guests: { none: {} },
      checkouts: { none: {} },
    },
  });
  return { purged: deleted.count };
}
