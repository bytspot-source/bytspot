import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const member: Context = { user: { userId: 'guest-1', email: 'guest@bytspot.com' }, clientRateLimitKey: 'test-feedback' };
const anonymous: Context = { user: null, clientRateLimitKey: 'test-feedback-anon' };
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

const partyGuest = db.partyGuest as any;
const planParticipant = db.planParticipant as any;
const feedback = db.feedback as any;
const feedbackDismissal = db.feedbackDismissal as any;
const partyMedia = db.partyMedia as any;
const venue = db.venue as any;

let upserted: any[];

beforeEach(() => {
  resetLocalRateLimitForTests();
  upserted = [];
  partyGuest.findMany = async () => [];
  partyGuest.findFirst = async () => null;
  planParticipant.findMany = async () => [];
  planParticipant.findFirst = async () => null;
  feedback.findMany = async () => [];
  feedbackDismissal.findMany = async () => [];
  partyMedia.findMany = async () => [];
  venue.findUnique = async () => null;
  feedback.upsert = async (args: any) => {
    upserted.push(args);
    return { ...args.create, ...args.update, createdAt: new Date('2026-10-18T18:00:00Z') };
  };
  feedbackDismissal.upsert = async (args: any) => { upserted.push(args); return args.create; };
});

test('Every feedback procedure needs a signed-in member', async () => {
  const anon = createCaller(anonymous);
  await assert.rejects(() => anon.feedback.pending(), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => anon.feedback.submit({ targetKind: 'party', targetId: 'p1', rating: 5 }), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => anon.feedback.dismiss({ targetKind: 'party', targetId: 'p1' }), { code: 'UNAUTHORIZED' });
});

test('pending lists what ended in the last week, newest first, leaving out rated and dismissed', async () => {
  let guestWhere: any;
  partyGuest.findMany = async ({ where }: any) => {
    guestWhere = where;
    return [
      { party: { id: 'p-recent', title: 'Pool Day', startsAt: ago(6 * HOUR), endsAt: ago(2 * HOUR) } },
      { party: { id: 'p-fallback', title: 'House', startsAt: ago(10 * HOUR), endsAt: null } },
      { party: { id: 'p-rated', title: 'Rated', startsAt: ago(6 * HOUR), endsAt: ago(3 * HOUR) } },
      { party: { id: 'p-old', title: 'Old', startsAt: ago(9 * 24 * HOUR), endsAt: ago(8 * 24 * HOUR) } },
      { party: { id: 'p-live', title: 'Still going', startsAt: ago(HOUR), endsAt: new Date(Date.now() + HOUR) } },
    ];
  };
  planParticipant.findMany = async () => [
    { plan: { id: 'plan-1', title: 'Friday Out', startsAt: ago(30 * HOUR), endsAt: null } },
    { plan: { id: 'plan-dismissed', title: 'Skipped', startsAt: ago(30 * HOUR), endsAt: null } },
  ];
  feedback.findMany = async () => [{ targetKind: 'party', targetId: 'p-rated' }];
  feedbackDismissal.findMany = async () => [{ targetKind: 'plan', targetId: 'plan-dismissed' }];
  partyMedia.findMany = async () => [{ id: 'cover-1', partyId: 'p-recent' }];

  const { pending } = await createCaller(member).feedback.pending();
  assert.deepEqual(pending.map((p) => p.targetId), ['p-recent', 'p-fallback', 'plan-1']);
  assert.match(pending[0].coverURL ?? '', /\/media\/parties\/cover-1$/);
  assert.equal(pending[1].coverURL, null);
  // No stated end: four hours past the start.
  assert.ok(Math.abs(Date.parse(pending[1].endedAt) - ago(6 * HOUR).getTime()) < 60_000);
  assert.deepEqual(Object.keys(pending[2]).sort(), ['coverURL', 'endedAt', 'targetId', 'targetKind', 'title']);
  // Only parties the member was let into, or checked in at.
  assert.equal(guestWhere.userId, 'guest-1');
  assert.deepEqual(guestWhere.OR, [{ accessGranted: true }, { checkedInAt: { not: null } }]);
});

test('submit refuses a target the member was not at, without saying whether it exists', async () => {
  await assert.rejects(() => createCaller(member).feedback.submit({ targetKind: 'party', targetId: 'p1', rating: 4 }), { code: 'NOT_FOUND' });
  await assert.rejects(() => createCaller(member).feedback.submit({ targetKind: 'plan', targetId: 'plan-1', rating: 4 }), { code: 'NOT_FOUND' });
  await assert.rejects(() => createCaller(member).feedback.submit({ targetKind: 'venue', targetId: 'v1', rating: 4 }), { code: 'NOT_FOUND' });
  // A Plan that has not begun cannot be rated yet.
  planParticipant.findFirst = async () => ({ plan: { startsAt: new Date(Date.now() + HOUR), endsAt: null } });
  await assert.rejects(() => createCaller(member).feedback.submit({ targetKind: 'plan', targetId: 'plan-1', rating: 4 }), { code: 'NOT_FOUND' });
  assert.deepEqual(upserted, []);
});

test('submit validates the rating, tags, and note', async () => {
  partyGuest.findFirst = async () => ({ id: 'g1' });
  const submit = (input: any) => createCaller(member).feedback.submit(input);
  await assert.rejects(() => submit({ targetKind: 'party', targetId: 'p1', rating: 0 }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => submit({ targetKind: 'party', targetId: 'p1', rating: 6 }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => submit({ targetKind: 'party', targetId: 'p1', rating: 4, note: 'x'.repeat(501) }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => submit({ targetKind: 'event', targetId: 'p1', rating: 4 }), { code: 'BAD_REQUEST' });
});

test('submit stores one rating per member and target, and a second replaces it', async () => {
  let asked: any;
  partyGuest.findFirst = async ({ where }: any) => { asked = where; return { id: 'g1' }; };
  const saved = await createCaller(member).feedback.submit({ targetKind: 'party', targetId: 'p1', rating: 5, tags: ['music', 'music', 'crowd'], note: '  Great night  ' });
  assert.deepEqual(saved, { targetKind: 'party', targetId: 'p1', rating: 5, tags: ['music', 'crowd'], note: 'Great night', createdAt: '2026-10-18T18:00:00.000Z' });
  assert.equal(asked.userId, 'guest-1');
  assert.deepEqual(upserted[0].where, { userId_targetKind_targetId: { userId: 'guest-1', targetKind: 'party', targetId: 'p1' } });
  assert.deepEqual(upserted[0].update, { rating: 5, tags: ['music', 'crowd'], note: 'Great night' });

  planParticipant.findFirst = async () => ({ plan: { startsAt: ago(5 * HOUR), endsAt: null } });
  const plan = await createCaller(member).feedback.submit({ targetKind: 'plan', targetId: 'plan-1', rating: 3 });
  assert.equal(plan.note, null);
  assert.deepEqual(plan.tags, []);
  venue.findUnique = async () => ({ id: 'v1' });
  assert.equal((await createCaller(member).feedback.submit({ targetKind: 'venue', targetId: 'v1', rating: 2 })).rating, 2);
});

test('dismiss is idempotent and scoped to the caller', async () => {
  const first = await createCaller(member).feedback.dismiss({ targetKind: 'plan', targetId: 'plan-1' });
  assert.deepEqual(first, { targetKind: 'plan', targetId: 'plan-1', dismissed: true });
  await createCaller(member).feedback.dismiss({ targetKind: 'plan', targetId: 'plan-1' });
  assert.equal(upserted.length, 2);
  assert.deepEqual(upserted[1].where, { userId_targetKind_targetId: { userId: 'guest-1', targetKind: 'plan', targetId: 'plan-1' } });
  assert.deepEqual(upserted[1].update, {});
});
