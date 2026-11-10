import type Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { config } from '../config';
import { getRedis } from '../lib/redis';

/**
 * Report and block (App Review Guideline 1.2). A block hides two members from
 * each other in both directions; a report goes to the admin Reports queue,
 * and enough independent reports hide the item until an admin decides.
 */

// REA review 2026-11-10, X4: Plans, party media, request notes, businesses
// and concierge answers are reportable too, and the reasons cover underage
// attendance, alcohol, illegal items and scams.
export const REPORT_KINDS = ['user', 'party', 'review', 'sale', 'plan', 'media', 'note', 'vendor', 'concierge'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_REASONS = [
  'spam', 'harassment', 'sexual', 'violence', 'impersonation',
  'underage', 'alcohol', 'illegal-item', 'scam',
  'other',
] as const;

/** Owner recorded for a concierge answer: Bytspot wrote it, not a member. */
export const CONCIERGE_OWNER_ID = 'bytspot:concierge';
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Distinct reporters with confirmed emails it takes to hide an item before review. */
export const AUTO_HIDE_REPORTERS = 3;
export const MAX_BLOCKS = 1000;

export const SUSPENDED_MESSAGE = 'This account has been suspended.';

/** Everyone the member blocked or was blocked by. */
export async function blockedUserIds(userId: string): Promise<Set<string>> {
  const rows = await db.userBlock.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return new Set(rows.map((row) => (row.blockerId === userId ? row.blockedId : row.blockerId)));
}

/** Whether either of the two blocked the other. */
export async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const row = await db.userBlock.findFirst({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Blocks and clears what is pending between the two: invitations and
 * connections, follows, circle places, open sale requests and unanswered Plan
 * invites. Passes and confirmed Plan seats stay, since taking them would move
 * money or bookings.
 */
export async function blockMember(blockerId: string, blockedId: string, now = new Date()): Promise<void> {
  const pair = (a: string, b: string) => [{ fromUserId: a, toUserId: b }, { fromUserId: b, toUserId: a }];
  await db.$transaction([
    db.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId },
      update: {},
    }),
    // Declined rows stay, so an unblock never resurfaces someone already turned down.
    db.socialInvitation.deleteMany({ where: { status: { in: ['pending', 'accepted'] }, OR: pair(blockerId, blockedId) } }),
    db.follow.deleteMany({
      where: { OR: [{ followerId: blockerId, followingId: blockedId }, { followerId: blockedId, followingId: blockerId }] },
    }),
    db.socialCircleMember.deleteMany({
      where: { OR: [{ userId: blockedId, circle: { ownerId: blockerId } }, { userId: blockerId, circle: { ownerId: blockedId } }] },
    }),
    db.privateSaleRequest.updateMany({
      where: {
        status: { in: ['pending', 'approved'] },
        OR: [{ buyerId: blockedId, sale: { sellerId: blockerId } }, { buyerId: blockerId, sale: { sellerId: blockedId } }],
      },
      data: { status: 'declined', decidedAt: now },
    }),
    db.planParticipant.updateMany({
      where: {
        status: 'invited',
        OR: [{ userId: blockedId, plan: { creatorUserId: blockerId } }, { userId: blockerId, plan: { creatorUserId: blockedId } }],
      },
      data: { status: 'removed' },
    }),
  ]);
}

export type ReportTarget = { ownerId: string; snapshot: Prisma.InputJsonObject };

/** What is being reported, as it stands now, or null if there is nothing to report. */
/** Concierge answers are not stored, so the id must still look like one. */
const CONCIERGE_RESPONSE_ID = /^[A-Za-z0-9_.:-]{6,128}$/;

export function isConciergeResponseId(id: string): boolean {
  return CONCIERGE_RESPONSE_ID.test(id);
}

export async function reportTarget(kind: ReportKind, id: string): Promise<ReportTarget | null> {
  switch (kind) {
    case 'user': {
      const user = await db.user.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true, profileImage: true } });
      return user ? { ownerId: user.id, snapshot: { name: user.name, profileImage: user.profileImage } } : null;
    }
    case 'party': {
      const party = await db.party.findFirst({
        where: { id, status: 'published' },
        select: { hostUserId: true, title: true, tagline: true, venueName: true, startsAt: true, media: { where: { kind: { in: ['cover', 'album'] } }, select: { id: true } } },
      });
      return party
        ? { ownerId: party.hostUserId, snapshot: { title: party.title, tagline: party.tagline, venueName: party.venueName, startsAt: party.startsAt.toISOString(), mediaIds: party.media.map((m) => m.id) } }
        : null;
    }
    case 'review': {
      const review = await db.review.findUnique({ where: { id }, select: { userId: true, stars: true, vibe: true, comment: true, venue: { select: { name: true } } } });
      return review
        ? { ownerId: review.userId, snapshot: { venueName: review.venue.name, stars: review.stars, vibe: review.vibe, comment: review.comment } }
        : null;
    }
    case 'sale': {
      const sale = await db.privateSale.findUnique({ where: { id }, select: { sellerId: true, title: true, priceCents: true, meetAreaLabel: true } });
      return sale
        ? { ownerId: sale.sellerId, snapshot: { title: sale.title, priceCents: sale.priceCents, areaLabel: sale.meetAreaLabel } }
        : null;
    }
    case 'plan': {
      // Never the anchor coordinates: the snapshot is read by admins only, but
      // it still need not carry where someone lives.
      const plan = await db.plan.findFirst({ where: { id, deletedAt: null }, select: { creatorUserId: true, title: true, intent: true, areaLabel: true, startsAt: true } });
      return plan
        ? { ownerId: plan.creatorUserId, snapshot: { title: plan.title, intent: plan.intent, areaLabel: plan.areaLabel, startsAt: plan.startsAt?.toISOString() ?? null } }
        : null;
    }
    case 'media': {
      const media = await db.partyMedia.findUnique({ where: { id }, select: { id: true, kind: true, partyId: true, party: { select: { hostUserId: true, title: true } } } });
      return media
        ? { ownerId: media.party.hostUserId, snapshot: { mediaId: media.id, mediaKind: media.kind, partyId: media.partyId, partyTitle: media.party.title } }
        : null;
    }
    case 'note': {
      const note = await db.partyRequestNote.findUnique({ where: { id }, select: { senderUserId: true, body: true, partyId: true } });
      return note ? { ownerId: note.senderUserId, snapshot: { body: note.body, partyId: note.partyId } } : null;
    }
    case 'vendor': {
      const seller = await db.vendorSeller.findUnique({
        where: { id },
        select: { id: true, legalName: true, seats: { where: { role: 'owner', state: 'ACTIVE' }, select: { userId: true }, take: 1 } },
      });
      return seller
        ? { ownerId: seller.seats[0]?.userId ?? `seller:${seller.id}`, snapshot: { sellerId: seller.id, legalName: seller.legalName } }
        : null;
    }
    case 'concierge':
      // Concierge answers are not stored; the reporter's excerpt is the
      // evidence, attached by the router. A badly shaped id is treated as
      // missing so the queue cannot be filled with arbitrary tokens.
      if (!isConciergeResponseId(id)) return null;
      return { ownerId: CONCIERGE_OWNER_ID, snapshot: { responseId: id } };
  }
}

/** Hides or shows a reported item for everyone who doesn't already hold access. A person has no item to hide. */
export async function setModerationHidden(kind: ReportKind, id: string, hidden: boolean, now = new Date()): Promise<void> {
  const where = hidden ? { id, moderationHiddenAt: null } : { id };
  const data = { moderationHiddenAt: hidden ? now : null };
  if (kind === 'party') await db.party.updateMany({ where, data });
  else if (kind === 'review') await db.review.updateMany({ where, data });
  else if (kind === 'sale') await db.privateSale.updateMany({ where, data });
  // A removed request note leaves the performer's queue. Media, Plans,
  // businesses and concierge answers have no hidden flag: an admin removes
  // media, pauses a business (admin.vendors.pause) or fixes the concierge.
  else if (kind === 'note' && hidden) await db.partyRequestNote.updateMany({ where: { id }, data: { status: 'dismissed' } });
}

/** Distinct reporters with confirmed emails whose reports on the item are still open. */
export function openVerifiedReporters(kind: ReportKind, id: string): Promise<number> {
  return db.contentReport.count({
    where: { targetKind: kind, targetId: id, status: 'open', reporter: { emailVerifiedAt: { not: null } } },
  });
}

const SUSPENDED_KEY = 'account:suspended';

/**
 * Marks live sessions of a suspended account as over. Access tokens last for
 * days, so the database flag alone would leave one working until it expired.
 */
export async function markSessionsSuspended(userId: string, suspended: boolean, redis: Redis | null = getRedis()): Promise<void> {
  if (!redis) return;
  try {
    if (suspended) await redis.set(`${SUSPENDED_KEY}:${userId}`, '1');
    else await redis.del(`${SUSPENDED_KEY}:${userId}`);
  } catch {
    // The database flag still refuses every sign-in and token renewal.
  }
}

/**
 * REA V3: with Redis missing or down this used to answer "not suspended" for
 * everyone, so a suspended member's live access token kept working for its
 * whole lifetime. It now falls back to the database flag, cached briefly per
 * process so an outage doesn't turn into a query per request. Only if the
 * database is also unreachable does it fail open (and the request will almost
 * certainly fail on its own database work anyway).
 */
const SUSPENSION_FALLBACK_TTL_MS = 30_000;
const suspensionFallback = new Map<string, { suspended: boolean; at: number }>();

export function resetSuspensionFallbackForTests(): void {
  suspensionFallback.clear();
}

async function suspendedInDatabase(userId: string, now = Date.now()): Promise<boolean> {
  const hit = suspensionFallback.get(userId);
  if (hit && now - hit.at < SUSPENSION_FALLBACK_TTL_MS) return hit.suspended;
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
    const suspended = Boolean(user?.suspendedAt);
    if (suspensionFallback.size > 50_000) suspensionFallback.clear();
    suspensionFallback.set(userId, { suspended, at: now });
    return suspended;
  } catch (error) {
    console.warn('[safety] suspension check fell through: Redis and database unavailable', (error as Error)?.message);
    return false;
  }
}

export async function isSessionSuspended(
  userId: string,
  redis: Redis | null = getRedis(),
  opts: { noRedisFallback?: boolean } = {},
): Promise<boolean> {
  // No Redis at all is a misconfiguration in production, so the database
  // answers there. Locally and in tests (no REDIS_URL) the old behaviour stands.
  if (!redis) return (opts.noRedisFallback ?? config.nodeEnv === 'production') ? suspendedInDatabase(userId) : false;
  try {
    return (await redis.exists(`${SUSPENDED_KEY}:${userId}`)) === 1;
  } catch {
    return suspendedInDatabase(userId);
  }
}
