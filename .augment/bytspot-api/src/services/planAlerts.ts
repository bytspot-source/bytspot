/**
 * Plan activity pushes. Someone added to a shared Plan; everyone else on it is
 * told, never the person who did it. A burst of adds is one push per Plan per
 * participant per coalescing window, so building a Plan does not page anyone.
 * An invited member is told once per Plan, and the creator is told once per
 * person who joins from the link. A change of time or place is coalesced the
 * same way as adds; confirming and cancelling are told once per Plan.
 */

import { db } from '../lib/db';
import { claimNotificationSend, planUrl, sendOnce, usersPermitting } from './scheduledPushes';
import { deliverPushNotification } from './notificationDelivery';

export const PLAN_ADD_COALESCE_MS = 2 * 60 * 1000;

const KEY_PREFIX = 'plan.item_added:';
const CHANGED_KEY_PREFIX = 'plan.changed:';

export type PlanChange = 'time' | 'place' | 'time_and_place';

export function planItemAddedCopy(input: { actorName: string | null; itemTitles: readonly string[]; planTitle: string }) {
  const who = input.actorName?.trim() || 'Someone';
  const plan = input.planTitle.trim() || 'your Plan';
  const [first, ...rest] = input.itemTitles.map((t) => t.trim()).filter(Boolean);
  const what = !first ? 'something' : rest.length === 0 ? first : `${first} and ${rest.length} more`;
  return { title: plan, body: `${who} added ${what} to ${plan}` };
}

/**
 * One push per Plan per participant per coalescing window for `keyPrefix`.
 * The bucket key makes two racing sends in the same window collide on the
 * unique index; the lookup covers sends either side of a boundary.
 */
async function sendCoalesced(input: {
  planId: string;
  keyPrefix: string;
  userIds: readonly string[];
  now: Date;
  type: string;
  copy: (actorName: string | null) => { title: string; body: string };
  actorUserId: string;
}): Promise<number> {
  const permitted = await usersPermitting(input.userIds, ['reminders']);
  if (permitted.length === 0) return 0;

  const since = new Date(input.now.getTime() - PLAN_ADD_COALESCE_MS);
  const recent = await db.notificationSend.findMany({
    where: { userId: { in: permitted }, dedupeKey: { startsWith: `${input.keyPrefix}${input.planId}:` }, sentAt: { gt: since } },
    select: { userId: true },
  });
  const recentlyTold = new Set(recent.map((row) => row.userId));
  const bucket = Math.floor(input.now.getTime() / PLAN_ADD_COALESCE_MS);
  const dedupeKey = `${input.keyPrefix}${input.planId}:${bucket}`;
  const claimed: string[] = [];
  for (const userId of permitted) {
    if (recentlyTold.has(userId)) continue;
    if (await claimNotificationSend(userId, dedupeKey)) claimed.push(userId);
  }
  if (claimed.length === 0) return 0;

  await deliverPushNotification({
    userIds: claimed,
    category: 'reminders',
    ...input.copy(await displayName(input.actorUserId)),
    url: planUrl(input.planId),
    type: input.type,
  });
  return claimed.length;
}

/** Everyone still on the Plan except the person who acted. */
async function planAudience(planId: string, actorUserId: string, opts: { allowCancelled?: boolean } = {}) {
  const plan = await db.plan.findUnique({
    where: { id: planId },
    select: {
      title: true, deletedAt: true, cancelledAt: true,
      participants: { where: { status: { notIn: ['declined', 'removed'] } }, select: { userId: true } },
    },
  });
  if (!plan || plan.deletedAt || (plan.cancelledAt && !opts.allowCancelled)) return null;
  return { title: plan.title, others: plan.participants.map((p) => p.userId).filter((id) => id !== actorUserId) };
}

export async function alertPlanItemAdded(input: {
  planId: string;
  actorUserId: string;
  itemTitles: readonly string[];
  now?: Date;
}): Promise<number> {
  if (input.itemTitles.length === 0) return 0;
  const plan = await planAudience(input.planId, input.actorUserId);
  if (!plan || plan.others.length === 0) return 0;
  return sendCoalesced({
    planId: input.planId,
    keyPrefix: KEY_PREFIX,
    userIds: plan.others,
    now: input.now ?? new Date(),
    type: 'plan.item_added',
    actorUserId: input.actorUserId,
    copy: (actorName) => planItemAddedCopy({ actorName, itemTitles: input.itemTitles, planTitle: plan.title }),
  });
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

export function planChangedCopy(input: { actorName: string | null; planTitle: string; change: PlanChange }) {
  const who = input.actorName?.trim() || 'Someone';
  const plan = input.planTitle.trim() || 'your Plan';
  const body = input.change === 'time'
    ? `${who} changed the time of ${plan}`
    : input.change === 'place'
      ? `${who} changed where ${plan} is`
      : `${who} changed the time and place of ${plan}`;
  return { title: plan, body };
}

export function planDecidedCopy(input: { actorName: string | null; planTitle: string; decision: 'confirmed' | 'cancelled' }) {
  const who = input.actorName?.trim() || 'Someone';
  const plan = input.planTitle.trim() || 'your Plan';
  return { title: plan, body: `${who} ${input.decision} ${plan}` };
}

export async function alertPlanChanged(input: { planId: string; actorUserId: string; change: PlanChange; now?: Date }): Promise<number> {
  const plan = await planAudience(input.planId, input.actorUserId);
  if (!plan || plan.others.length === 0) return 0;
  return sendCoalesced({
    planId: input.planId,
    keyPrefix: CHANGED_KEY_PREFIX,
    userIds: plan.others,
    now: input.now ?? new Date(),
    type: 'plan.changed',
    actorUserId: input.actorUserId,
    copy: (actorName) => planChangedCopy({ actorName, planTitle: plan.title, change: input.change }),
  });
}

export async function alertPlanDecided(input: { planId: string; actorUserId: string; decision: 'confirmed' | 'cancelled' }): Promise<number> {
  const plan = await planAudience(input.planId, input.actorUserId, { allowCancelled: input.decision === 'cancelled' });
  if (!plan || plan.others.length === 0) return 0;
  const copy = planDecidedCopy({ actorName: await displayName(input.actorUserId), planTitle: plan.title, decision: input.decision });
  return sendOnce({
    userIds: plan.others,
    categories: ['reminders'],
    dedupeKey: `plan.${input.decision}:${input.planId}`,
    ...copy,
    url: planUrl(input.planId),
    type: `plan.${input.decision}`,
  });
}

export function dispatchPlanChanged(input: Parameters<typeof alertPlanChanged>[0]): void {
  void alertPlanChanged(input).catch(() => {});
}

export function dispatchPlanDecided(input: Parameters<typeof alertPlanDecided>[0]): void {
  void alertPlanDecided(input).catch(() => {});
}
