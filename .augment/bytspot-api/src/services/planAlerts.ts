/**
 * Plan activity pushes. Someone added to a shared Plan; everyone else on it is
 * told, never the person who did it. A burst of adds is one push per Plan per
 * participant per coalescing window, so building a Plan does not page anyone.
 * An invited member is told once per Plan, and the creator is told once per
 * person who joins from the link.
 */

import { db } from '../lib/db';
import { claimNotificationSend, planUrl, sendOnce, usersPermitting } from './scheduledPushes';
import { deliverPushNotification } from './notificationDelivery';

export const PLAN_ADD_COALESCE_MS = 2 * 60 * 1000;

const KEY_PREFIX = 'plan.item_added:';

export function planItemAddedCopy(input: { actorName: string | null; itemTitles: readonly string[]; planTitle: string }) {
  const who = input.actorName?.trim() || 'Someone';
  const plan = input.planTitle.trim() || 'your Plan';
  const [first, ...rest] = input.itemTitles.map((t) => t.trim()).filter(Boolean);
  const what = !first ? 'something' : rest.length === 0 ? first : `${first} and ${rest.length} more`;
  return { title: plan, body: `${who} added ${what} to ${plan}` };
}

export async function alertPlanItemAdded(input: {
  planId: string;
  actorUserId: string;
  itemTitles: readonly string[];
  now?: Date;
}): Promise<number> {
  if (input.itemTitles.length === 0) return 0;
  const now = input.now ?? new Date();
  const plan = await db.plan.findUnique({
    where: { id: input.planId },
    select: {
      title: true, deletedAt: true, cancelledAt: true,
      participants: { where: { status: { notIn: ['declined', 'removed'] } }, select: { userId: true } },
    },
  });
  if (!plan || plan.deletedAt || plan.cancelledAt) return 0;
  const others = plan.participants.map((p) => p.userId).filter((id) => id !== input.actorUserId);
  const permitted = await usersPermitting(others, ['reminders']);
  if (permitted.length === 0) return 0;

  const since = new Date(now.getTime() - PLAN_ADD_COALESCE_MS);
  const recent = await db.notificationSend.findMany({
    where: { userId: { in: permitted }, dedupeKey: { startsWith: `${KEY_PREFIX}${input.planId}:` }, sentAt: { gt: since } },
    select: { userId: true },
  });
  const recentlyTold = new Set(recent.map((row) => row.userId));
  // The bucket key makes two racing adds in the same window collide on the
  // unique index; the lookup above covers adds either side of a boundary.
  const bucket = Math.floor(now.getTime() / PLAN_ADD_COALESCE_MS);
  const dedupeKey = `${KEY_PREFIX}${input.planId}:${bucket}`;
  const claimed: string[] = [];
  for (const userId of permitted) {
    if (recentlyTold.has(userId)) continue;
    if (await claimNotificationSend(userId, dedupeKey)) claimed.push(userId);
  }
  if (claimed.length === 0) return 0;

  const actor = await db.user.findUnique({ where: { id: input.actorUserId }, select: { name: true } }).catch(() => null);
  const copy = planItemAddedCopy({ actorName: actor?.name ?? null, itemTitles: input.itemTitles, planTitle: plan.title });
  await deliverPushNotification({
    userIds: claimed,
    category: 'reminders',
    ...copy,
    url: planUrl(input.planId),
    type: 'plan.item_added',
  });
  return claimed.length;
}

/** A push is a courtesy on top of a completed write; it must never fail it. */
export function dispatchPlanItemAdded(input: Parameters<typeof alertPlanItemAdded>[0]): void {
  void alertPlanItemAdded(input).catch(() => {});
}

export function planInvitedCopy(input: { inviterName: string | null; planTitle: string }) {
  const who = input.inviterName?.trim() || 'Someone';
  const plan = input.planTitle.trim() || 'a Plan';
  return { title: 'Plan invite', body: `${who} invited you to ${plan}` };
}

export function planJoinedCopy(input: { joinerName: string | null; planTitle: string }) {
  const who = input.joinerName?.trim() || 'Someone';
  const plan = input.planTitle.trim() || 'your Plan';
  return { title: plan, body: `${who} joined ${plan}` };
}

async function openPlanTitle(planId: string): Promise<{ title: string; creatorUserId: string } | null> {
  const plan = await db.plan.findUnique({
    where: { id: planId },
    select: { title: true, creatorUserId: true, deletedAt: true, cancelledAt: true },
  });
  if (!plan || plan.deletedAt || plan.cancelledAt) return null;
  return { title: plan.title, creatorUserId: plan.creatorUserId };
}

async function displayName(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } }).catch(() => null);
  return user?.name ?? null;
}

export async function alertPlanInvited(input: { planId: string; inviterUserId: string; inviteeUserId: string }): Promise<number> {
  if (input.inviteeUserId === input.inviterUserId) return 0;
  const plan = await openPlanTitle(input.planId);
  if (!plan) return 0;
  const copy = planInvitedCopy({ inviterName: await displayName(input.inviterUserId), planTitle: plan.title });
  return sendOnce({
    userIds: [input.inviteeUserId],
    categories: ['reminders'],
    dedupeKey: `plan.invited:${input.planId}`,
    ...copy,
    url: planUrl(input.planId),
    type: 'plan.invited',
  });
}

export async function alertPlanJoined(input: { planId: string; joinerUserId: string }): Promise<number> {
  const plan = await openPlanTitle(input.planId);
  if (!plan || plan.creatorUserId === input.joinerUserId) return 0;
  const copy = planJoinedCopy({ joinerName: await displayName(input.joinerUserId), planTitle: plan.title });
  return sendOnce({
    userIds: [plan.creatorUserId],
    categories: ['reminders'],
    dedupeKey: `plan.joined:${input.planId}:${input.joinerUserId}`,
    ...copy,
    url: planUrl(input.planId),
    type: 'plan.joined',
  });
}

export function dispatchPlanInvited(input: Parameters<typeof alertPlanInvited>[0]): void {
  void alertPlanInvited(input).catch(() => {});
}

export function dispatchPlanJoined(input: Parameters<typeof alertPlanJoined>[0]): void {
  void alertPlanJoined(input).catch(() => {});
}
