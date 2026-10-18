import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { alertPlanItemAdded, planItemAddedCopy, PLAN_ADD_COALESCE_MS } from './planAlerts';

const now = new Date('2026-10-18T18:00:00Z');
let sends: { userId: string; dedupeKey: string; sentAt: Date }[];
let addressed: string[][];
let participants: { userId: string }[];
let prefs: Record<string, unknown>;

beforeEach(() => {
  sends = [];
  addressed = [];
  prefs = {};
  participants = [{ userId: 'creator' }, { userId: 'friend' }, { userId: 'other' }];
  (db.plan as any).findUnique = async () => ({ title: 'Friday Out', deletedAt: null, cancelledAt: null, participants });
  (db.user as any).findMany = async ({ where }: any) => where.id.in.map((id: string) => ({ id, notificationPrefs: prefs[id] ?? null }));
  (db.user as any).findUnique = async () => ({ name: 'Ada' });
  (db.notificationSend as any).findMany = async ({ where }: any) => sends.filter((s) => where.userId.in.includes(s.userId)
    && s.dedupeKey.startsWith(where.dedupeKey.startsWith) && s.sentAt > where.sentAt.gt);
  (db.notificationSend as any).create = async ({ data }: any) => {
    if (sends.some((s) => s.userId === data.userId && s.dedupeKey === data.dedupeKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
    sends.push({ ...data, sentAt: currentTime });
    return data;
  };
  (db.iOSPushDevice as any).findMany = async ({ where }: any) => { addressed.push(where.userId.in); return []; };
});

let currentTime = now;
async function add(actorUserId: string, itemTitles: string[], when: Date) {
  currentTime = when;
  return alertPlanItemAdded({ planId: 'plan-1', actorUserId, itemTitles, now: when });
}

test('The copy names who added what to which Plan', () => {
  assert.deepEqual(planItemAddedCopy({ actorName: 'Ada', itemTitles: ['Dinner'], planTitle: 'Friday Out' }), { title: 'Friday Out', body: 'Ada added Dinner to Friday Out' });
  assert.equal(planItemAddedCopy({ actorName: null, itemTitles: ['Dinner', 'Drinks', 'Dessert'], planTitle: 'Friday Out' }).body, 'Someone added Dinner and 2 more to Friday Out');
});

test('Everyone else on the Plan is told, never the person who added', async () => {
  assert.equal(await add('creator', ['Dinner'], now), 2);
  assert.deepEqual(addressed, [['friend', 'other']]);
  assert.ok(sends.every((s) => s.userId !== 'creator'));
});

test('A participant who turned reminders off is not told', async () => {
  prefs = { other: { push: { reminders: false } } };
  assert.equal(await add('creator', ['Dinner'], now), 1);
  assert.deepEqual(addressed, [['friend']]);
});

test('A burst of adds is one push per participant per window, across a bucket boundary too', async () => {
  await add('creator', ['Dinner'], now);
  assert.equal(await add('creator', ['Drinks'], new Date(now.getTime() + 30 * 1000)), 0);
  // Into the next bucket but still inside the window since the last push.
  assert.equal(await add('creator', ['Dessert'], new Date(now.getTime() + PLAN_ADD_COALESCE_MS - 1000)), 0);
  assert.equal(addressed.length, 1);
  // Past the window, the next add is news again.
  assert.equal(await add('creator', ['Late show'], new Date(now.getTime() + PLAN_ADD_COALESCE_MS + 1000)), 2);
});

test('A different actor in the same burst does not page the first actor twice, and is not paged themselves', async () => {
  await add('creator', ['Dinner'], now);
  assert.equal(await add('friend', ['Drinks'], new Date(now.getTime() + 10 * 1000)), 1);
  assert.deepEqual(addressed.at(-1), ['creator']);
});

test('A deleted Plan and an empty add notify nobody', async () => {
  assert.equal(await add('creator', [], now), 0);
  (db.plan as any).findUnique = async () => ({ title: 'Gone', deletedAt: now, cancelledAt: null, participants });
  assert.equal(await add('creator', ['Dinner'], now), 0);
  assert.deepEqual(addressed, []);
});
