import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { isAllowedBytspotUrl } from './notificationDelivery';
import {
  dueReminderStage,
  endedAt,
  feedbackRequestDue,
  feedbackUrl,
  joinedBeforeStage,
  partyUrl,
  planUrl,
  REMINDER_STAGES,
  sendUpcomingReminders,
} from './scheduledPushes';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const now = new Date('2026-10-18T18:00:00Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

type Push = { userIds: string[]; category: string };
let sends: { userId: string; dedupeKey: string }[];
let pushes: Push[];
let prefs: Record<string, unknown>;
let parties: any[];
let plans: any[];
let feedbackRows: { userId: string }[];
let dismissals: { userId: string }[];

beforeEach(() => {
  sends = [];
  pushes = [];
  prefs = {};
  parties = [];
  plans = [];
  feedbackRows = [];
  dismissals = [];
  (db.notificationSend as any).create = async ({ data }: any) => {
    if (sends.some((s) => s.userId === data.userId && s.dedupeKey === data.dedupeKey)) {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
    sends.push(data);
    return data;
  };
  (db.user as any).findMany = async ({ where }: any) => where.id.in.map((id: string) => ({ id, notificationPrefs: prefs[id] ?? null }));
  // The device read is where a push resolves its audience; recording it is
  // recording who was addressed.
  (db.iOSPushDevice as any).findMany = async ({ where }: any) => {
    pushes.push({ userIds: where.userId.in, category: '' });
    return [];
  };
  // A party window query is told apart from a feedback query by its startsAt shape.
  (db.party as any).findMany = async ({ where }: any) => (where.OR ? parties.filter((p) => p.forFeedback) : parties.filter((p) => !p.forFeedback));
  (db.plan as any).findMany = async ({ where }: any) => (where.OR ? plans.filter((p) => p.forFeedback) : plans.filter((p) => !p.forFeedback));
  (db.feedback as any).findMany = async () => feedbackRows;
  (db.feedbackDismissal as any).findMany = async () => dismissals;
});

function upcomingParty(startsIn: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 'party-1', title: 'Rooftop Listening', startsAt: at(startsIn), hostUserId: 'host',
    publishedAt: at(-3 * 24 * HOUR), createdAt: at(-4 * 24 * HOUR),
    guests: [
      { userId: 'early', createdAt: at(-2 * 24 * HOUR) },
      { userId: 'late', createdAt: at(-1 * HOUR) },
    ],
    ...overrides,
  };
}

test('Each stage is a window wider than the five-minute cadence, and no two overlap', () => {
  for (const stage of REMINDER_STAGES) assert.ok(stage.toleranceMs >= 15 * MIN, `${stage.stage} must span several runs`);
  // Every five-minute tick across the 2h window lands in it at least three times.
  const hits = [0, 5, 10, 15, 20, 25].map((m) => dueReminderStage(at(2 * HOUR - m * MIN), now)?.stage);
  assert.deepEqual(hits, ['2h', '2h', '2h', '2h', undefined, undefined]);
  assert.equal(dueReminderStage(at(24 * HOUR), now)?.stage, '24h');
  assert.equal(dueReminderStage(at(24 * HOUR + MIN), now), null);
  assert.equal(dueReminderStage(at(30 * MIN), now)?.stage, '30m');
  assert.equal(dueReminderStage(at(14 * MIN), now), null);
  assert.equal(dueReminderStage(at(5 * HOUR), now), null);
});

test('A reminder is only for someone who joined before its lead', () => {
  const startsAt = at(24 * HOUR);
  assert.equal(joinedBeforeStage(at(-1 * MIN), startsAt, 24 * HOUR), true);
  assert.equal(joinedBeforeStage(at(1 * MIN), startsAt, 24 * HOUR), false);
});

test('The end falls back to four hours past the start', () => {
  assert.deepEqual(endedAt({ startsAt: now, endsAt: null }), at(4 * HOUR));
  assert.deepEqual(endedAt({ startsAt: now, endsAt: at(HOUR) }), at(HOUR));
  assert.equal(endedAt({ startsAt: null, endsAt: null }), null);
  assert.equal(feedbackRequestDue(at(-59 * MIN), now), false);
  assert.equal(feedbackRequestDue(at(-61 * MIN), now), true);
  assert.equal(feedbackRequestDue(at(-3 * HOUR), now), false);
});

test('Every link these pushes carry is one the app routes and delivery accepts', () => {
  for (const url of [partyUrl('p1'), partyUrl('p1', 'arrival'), planUrl('pl1'), feedbackUrl('party', 'p1'), feedbackUrl('plan', 'pl1')]) {
    assert.ok(isAllowedBytspotUrl(url), url);
  }
  assert.equal(partyUrl('p1', 'arrival'), 'https://bytspot.app/party/p1?intent=arrival');
  assert.equal(planUrl('pl1'), 'https://bytspot.app/plan/pl1');
  assert.equal(feedbackUrl('party', 'p1'), 'https://bytspot.app/feedback?kind=party&id=p1');
});

test('The 24h reminder skips anyone who RSVPd inside the last day, and repeats never double-send', async () => {
  parties = [upcomingParty(24 * HOUR - 2 * MIN, {
    guests: [{ userId: 'early', createdAt: at(-2 * 24 * HOUR) }, { userId: 'late', createdAt: at(-1 * MIN) }],
  })];
  const first = await sendUpcomingReminders(now);
  assert.equal(first.partyReminders, 2);
  assert.deepEqual(pushes.map((p) => p.userIds.sort()), [['early', 'host']]);
  assert.deepEqual(sends.map((s) => s.dedupeKey), ['reminder.party:party-1:24h', 'reminder.party:party-1:24h']);
  // The next run five minutes later is inside the same window.
  pushes = [];
  const second = await sendUpcomingReminders(new Date(now.getTime() + 5 * MIN));
  assert.equal(second.partyReminders, 0);
  assert.deepEqual(pushes, []);
});

test('The 30-minute reminder reaches a late RSVP and carries the arrival intent', async () => {
  parties = [upcomingParty(25 * MIN, { guests: [{ userId: 'late', createdAt: at(-1 * HOUR) }] })];
  const result = await sendUpcomingReminders(now);
  assert.equal(result.partyReminders, 2);
  assert.deepEqual(sends.map((s) => s.dedupeKey).sort(), ['reminder.party:party-1:30m', 'reminder.party:party-1:30m']);
});

test('Party reminders respect both the reminders and the party preference', async () => {
  parties = [upcomingParty(2 * HOUR - MIN, {
    guests: [
      { userId: 'no-reminders', createdAt: at(-3 * HOUR) },
      { userId: 'no-party', createdAt: at(-3 * HOUR) },
      { userId: 'both', createdAt: at(-3 * HOUR) },
    ],
  })];
  prefs = {
    host: { push: { reminders: false } },
    'no-reminders': { push: { reminders: false } },
    'no-party': { push: { party: false } },
  };
  await sendUpcomingReminders(now);
  assert.deepEqual(pushes.map((p) => p.userIds), [['both']]);
  assert.deepEqual(sends.map((s) => s.userId), ['both']);
});

test('Plan reminders go to every participant still on the Plan', async () => {
  plans = [{
    id: 'plan-1', title: 'Friday Out', startsAt: at(2 * HOUR - MIN),
    participants: [{ userId: 'creator', createdAt: at(-5 * HOUR) }, { userId: 'friend', createdAt: at(-4 * HOUR) }],
    items: [{ title: 'Dinner' }],
  }];
  const result = await sendUpcomingReminders(now);
  assert.equal(result.planReminders, 2);
  assert.deepEqual(sends.map((s) => s.dedupeKey), ['reminder.plan:plan-1:2h', 'reminder.plan:plan-1:2h']);
});

test('The feedback prompt goes once, an hour after the end, to whoever has not rated or dismissed', async () => {
  parties = [{
    id: 'party-9', title: 'Pool Day', forFeedback: true, startsAt: at(-5 * HOUR), endsAt: at(-70 * MIN),
    guests: [{ userId: 'rated' }, { userId: 'dismissed' }, { userId: 'waiting' }],
  }];
  feedbackRows = [{ userId: 'rated' }];
  dismissals = [{ userId: 'dismissed' }];
  const result = await sendUpcomingReminders(now);
  assert.equal(result.feedbackRequests, 1);
  assert.deepEqual(sends, [{ userId: 'waiting', dedupeKey: 'feedback.request:party:party-9' }]);
  assert.equal((await sendUpcomingReminders(new Date(now.getTime() + 5 * MIN))).feedbackRequests, 0);
});
