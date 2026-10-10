import type Redis from 'ioredis';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';

/**
 * Report and block (App Review Guideline 1.2). A block hides two members from
 * each other in both directions; a report goes to the admin Reports queue,
 * and enough independent reports hide the item until an admin decides.
 */

export const REPORT_KINDS = ['user', 'party', 'review', 'sale'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_REASONS = ['spam', 'harassment', 'sexual', 'violence', 'impersonation', 'other'] as const;
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
  }
}

/** Hides or shows a reported item for everyone who doesn't already hold access. A person has no item to hide. */
export async function setModerationHidden(kind: ReportKind, id: string, hidden: boolean, now = new Date()): Promise<void> {
  const where = hidden ? { id, moderationHiddenAt: null } : { id };
  const data = { moderationHiddenAt: hidden ? now : null };
  if (kind === 'party') await db.party.updateMany({ where, data });
  else if (kind === 'review') await db.review.updateMany({ where, data });
  else if (kind === 'sale') await db.privateSale.updateMany({ where, data });
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

export async function isSessionSuspended(userId: string, redis: Redis | null = getRedis()): Promise<boolean> {
  if (!redis) return false;
  try {
    return (await redis.exists(`${SUSPENDED_KEY}:${userId}`)) === 1;
  } catch {
    // Fail open, as isSessionRevoked does: a Redis outage must not lock out every member.
    return false;
  }
}
