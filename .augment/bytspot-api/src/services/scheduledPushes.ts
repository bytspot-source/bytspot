/**
 * Scheduled pushes: reminders as a Party or Plan approaches, and the one
 * feedback prompt after it ends.
 *
 * Runs on a five-minute cadence. Each stage is a window a little wider than
 * the cadence, so a late or skipped run still lands inside it, and every send
 * claims a NotificationSend key first, so overlapping runs cannot repeat one.
 * Copy names the Party or Plan and never an address: a location withheld
 * until approval must not arrive on a lock screen.
 */

import { db } from '../lib/db';
import { config } from '../config';
import { deliverPushNotification } from './notificationDelivery';
import { permitsCategory, type PushCategory } from './iosPushDevices';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A Party or Plan with no stated end is taken to have ended this long after it started. */
export const FALLBACK_LENGTH_MS = 4 * HOUR_MS;

export type ReminderStage = '24h' | '2h' | '30m';

/** Windows are (lead - tolerance, lead]; none overlap, and each spans several runs. */
export const REMINDER_STAGES: readonly { stage: ReminderStage; leadMs: number; toleranceMs: number }[] = [
  { stage: '24h', leadMs: 24 * HOUR_MS, toleranceMs: 30 * MINUTE_MS },
  { stage: '2h', leadMs: 2 * HOUR_MS, toleranceMs: 20 * MINUTE_MS },
  { stage: '30m', leadMs: 30 * MINUTE_MS, toleranceMs: 15 * MINUTE_MS },
];

/** The feedback prompt goes out an hour after the end, inside this window. */
export const FEEDBACK_DELAY_MS = HOUR_MS;
export const FEEDBACK_TOLERANCE_MS = 45 * MINUTE_MS;

export function dueReminderStage(startsAt: Date, now: Date) {
  const until = startsAt.getTime() - now.getTime();
  return REMINDER_STAGES.find((s) => until <= s.leadMs && until > s.leadMs - s.toleranceMs) ?? null;
}

/** Someone who joined inside a stage's lead is not reminded of what they just did. */
export function joinedBeforeStage(joinedAt: Date, startsAt: Date, leadMs: number): boolean {
  return joinedAt.getTime() <= startsAt.getTime() - leadMs;
}

export function endedAt(target: { startsAt: Date | null; endsAt: Date | null }): Date | null {
  if (target.endsAt) return target.endsAt;
  return target.startsAt ? new Date(target.startsAt.getTime() + FALLBACK_LENGTH_MS) : null;
}

export function feedbackRequestDue(ended: Date, now: Date): boolean {
  const since = now.getTime() - ended.getTime();
  return since >= FEEDBACK_DELAY_MS && since < FEEDBACK_DELAY_MS + FEEDBACK_TOLERANCE_MS;
}

export function partyUrl(partyId: string, intent?: 'arrival'): string {
  return `${config.partyShareBaseUrl}/party/${encodeURIComponent(partyId)}${intent ? `?intent=${intent}` : ''}`;
}

export function planUrl(planId: string): string {
  return `${config.partyShareBaseUrl}/plan/${encodeURIComponent(planId)}`;
}

export function feedbackUrl(kind: 'party' | 'plan', id: string): string {
  return `${config.partyShareBaseUrl}/feedback?kind=${kind}&id=${encodeURIComponent(id)}`;
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** True when this caller now owns the send; false when someone already did. */
export async function claimNotificationSend(userId: string, dedupeKey: string): Promise<boolean> {
  try {
    await db.notificationSend.create({ data: { userId, dedupeKey } });
    return true;
  } catch (error) {
    if (isUniqueConstraint(error)) return false;
    throw error;
  }
}

/** Members who allow every category named. Deleted accounts are never addressed. */
export async function usersPermitting(userIds: readonly string[], categories: readonly PushCategory[]): Promise<string[]> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const users = await db.user.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true, notificationPrefs: true },
  });
  return users.filter((u) => categories.every((c) => permitsCategory(u.notificationPrefs, c))).map((u) => u.id);
}

/** Claims, then sends, to whoever has not had this key. Returns how many were claimed. */
export async function sendOnce(input: {
  userIds: readonly string[];
  categories: readonly PushCategory[];
  dedupeKey: string;
  title: string;
  body: string;
  url: string;
  type: string;
}): Promise<number> {
  const permitted = await usersPermitting(input.userIds, input.categories);
  const claimed: string[] = [];
  for (const userId of permitted) {
    if (await claimNotificationSend(userId, input.dedupeKey)) claimed.push(userId);
  }
  if (claimed.length === 0) return 0;
  await deliverPushNotification({
    userIds: claimed,
    category: input.categories[0],
    title: input.title,
    body: input.body,
    url: input.url,
    type: input.type,
  });
  return claimed.length;
}

function partyReminderCopy(stage: ReminderStage, title: string) {
  if (stage === '24h') return { title: `Tomorrow: ${title}`, body: 'Starts in about 24 hours. Your pass is in Bytspot.' };
  if (stage === '2h') return { title: `${title} starts in 2 hours`, body: 'Get ready. Your pass is in Bytspot.' };
  return { title: 'Time to head out', body: `${title} starts in 30 minutes. Tap for directions.` };
}

function planReminderCopy(stage: ReminderStage, title: string, firstItem: string | null) {
  const first = firstItem ? ` First up: ${firstItem}.` : '';
  if (stage === '24h') return { title: `Tomorrow: ${title}`, body: `Starts in about 24 hours.${first}` };
  if (stage === '2h') return { title: `${title} starts in 2 hours`, body: `Get ready.${first}` };
  return { title: 'Time to head out', body: `${title} starts in 30 minutes.${first}` };
}

const PARTY_ATTENDING = { OR: [{ accessGranted: true }, { status: { in: ['joined', 'approved'] } }] };

async function sendPartyReminders(now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_STAGES[0].leadMs);
  const parties = await db.party.findMany({
    where: { status: 'published', closedAt: null, moderationHiddenAt: null, startsAt: { gt: now, lte: horizon } },
    select: {
      id: true, title: true, startsAt: true, hostUserId: true, publishedAt: true, createdAt: true,
      guests: { where: PARTY_ATTENDING, select: { userId: true, createdAt: true } },
    },
    take: 500,
  });
  let sent = 0;
  for (const party of parties) {
    const due = dueReminderStage(party.startsAt, now);
    if (!due) continue;
    const audience = [
      { userId: party.hostUserId, joinedAt: party.publishedAt ?? party.createdAt },
      ...party.guests.map((g) => ({ userId: g.userId, joinedAt: g.createdAt })),
    ].filter((m) => joinedBeforeStage(m.joinedAt, party.startsAt, due.leadMs));
    const copy = partyReminderCopy(due.stage, party.title.trim() || 'Your Party');
    sent += await sendOnce({
      userIds: audience.map((m) => m.userId),
      categories: ['reminders', 'party'],
      dedupeKey: `reminder.party:${party.id}:${due.stage}`,
      ...copy,
      url: partyUrl(party.id, due.stage === '30m' ? 'arrival' : undefined),
      type: 'reminder.party',
    });
  }
  return sent;
}

const PLAN_PRESENT = { status: { notIn: ['declined', 'removed'] } };

async function sendPlanReminders(now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_STAGES[0].leadMs);
  const plans = await db.plan.findMany({
    where: { deletedAt: null, cancelledAt: null, lifecycle: { not: 'cancelled' }, startsAt: { gt: now, lte: horizon } },
    select: {
      id: true, title: true, startsAt: true,
      participants: { where: PLAN_PRESENT, select: { userId: true, createdAt: true } },
      items: {
        where: { status: { not: 'cancelled' } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { title: true },
      },
    },
    take: 500,
  });
  let sent = 0;
  for (const plan of plans) {
    if (!plan.startsAt) continue;
    const due = dueReminderStage(plan.startsAt, now);
    if (!due) continue;
    const startsAt = plan.startsAt;
    const audience = plan.participants.filter((p) => joinedBeforeStage(p.createdAt, startsAt, due.leadMs));
    const copy = planReminderCopy(due.stage, plan.title.trim() || 'Your Plan', plan.items[0]?.title.trim() || null);
    sent += await sendOnce({
      userIds: audience.map((p) => p.userId),
      categories: ['reminders'],
      dedupeKey: `reminder.plan:${plan.id}:${due.stage}`,
      ...copy,
      url: planUrl(plan.id),
      type: 'reminder.plan',
    });
  }
  return sent;
}

/** Users who already rated or dismissed this target. */
async function feedbackSettled(targetKind: 'party' | 'plan', targetId: string): Promise<Set<string>> {
  const [rated, dismissed] = await Promise.all([
    db.feedback.findMany({ where: { targetKind, targetId }, select: { userId: true } }),
    db.feedbackDismissal.findMany({ where: { targetKind, targetId }, select: { userId: true } }),
  ]);
  return new Set([...rated, ...dismissed].map((row) => row.userId));
}

/** The range a stored end must fall in for its prompt to be due now. */
function feedbackEndRange(now: Date) {
  return {
    gt: new Date(now.getTime() - FEEDBACK_DELAY_MS - FEEDBACK_TOLERANCE_MS),
    lte: new Date(now.getTime() - FEEDBACK_DELAY_MS),
  };
}

function shiftRange(range: { gt: Date; lte: Date }, byMs: number) {
  return { gt: new Date(range.gt.getTime() - byMs), lte: new Date(range.lte.getTime() - byMs) };
}

async function sendFeedbackRequests(now: Date): Promise<number> {
  const ends = feedbackEndRange(now);
  const starts = shiftRange(ends, FALLBACK_LENGTH_MS);
  const [parties, plans] = await Promise.all([
    db.party.findMany({
      where: { status: 'published', moderationHiddenAt: null, OR: [{ endsAt: ends }, { endsAt: null, startsAt: starts }] },
      select: {
        id: true, title: true, startsAt: true, endsAt: true,
        guests: { where: { OR: [{ accessGranted: true }, { checkedInAt: { not: null } }] }, select: { userId: true } },
      },
      take: 500,
    }),
    db.plan.findMany({
      where: { deletedAt: null, cancelledAt: null, lifecycle: { not: 'cancelled' }, OR: [{ endsAt: ends }, { endsAt: null, startsAt: starts }] },
      select: {
        id: true, title: true, startsAt: true, endsAt: true,
        participants: { where: PLAN_PRESENT, select: { userId: true } },
      },
      take: 500,
    }),
  ]);
  const targets = [
    ...parties.map((p) => ({ kind: 'party' as const, id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, userIds: p.guests.map((g) => g.userId) })),
    ...plans.map((p) => ({ kind: 'plan' as const, id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, userIds: p.participants.map((m) => m.userId) })),
  ];
  let sent = 0;
  for (const target of targets) {
    const ended = endedAt(target);
    if (!ended || !feedbackRequestDue(ended, now) || target.userIds.length === 0) continue;
    const settled = await feedbackSettled(target.kind, target.id);
    const title = target.title.trim() || (target.kind === 'party' ? 'the Party' : 'your Plan');
    sent += await sendOnce({
      userIds: target.userIds.filter((id) => !settled.has(id)),
      categories: ['reminders'],
      dedupeKey: `feedback.request:${target.kind}:${target.id}`,
      title: `How was ${title}?`,
      body: 'Tap to rate',
      url: feedbackUrl(target.kind, target.id),
      type: 'feedback.request',
    });
  }
  return sent;
}

export async function sendUpcomingReminders(now: Date = new Date()): Promise<{ partyReminders: number; planReminders: number; feedbackRequests: number }> {
  const partyReminders = await sendPartyReminders(now);
  const planReminders = await sendPlanReminders(now);
  const feedbackRequests = await sendFeedbackRequests(now);
  return { partyReminders, planReminders, feedbackRequests };
}
