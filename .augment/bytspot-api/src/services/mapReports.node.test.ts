import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import { db } from '../lib/db';
import type { Context } from '../trpc/context';
import {
  CONFIRMED_REPORT_POINTS,
  MAX_REPORT_AGE_MS,
  REPORT_LIFETIME_MS,
  judgeReport,
  onMapReportChange,
  requiredAgreementFor,
  type MapReportChange,
  type ReportVote,
} from './mapReports';

const MIN = 60_000;
const now = new Date('2026-10-11T22:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * MIN);
const judge = (votes: ReportVote[], extra: Partial<Parameters<typeof judgeReport>[0]> = {}) =>
  judgeReport({ createdAt: ago(2), weight: 1, requiredAgreement: 2, confirmedAt: null, votes, now, ...extra });
const still = (minutes: number, weight = 1): ReportVote => ({ vote: 'still', weight, votedAt: ago(minutes) });
const gone = (minutes: number, weight = 1): ReportVote => ({ vote: 'gone', weight, votedAt: ago(minutes) });

test('one report alone stays unconfirmed; a second member within ten minutes confirms it', () => {
  assert.equal(judge([]).confirmed, false);
  assert.equal(judge([still(1)]).confirmed, true);
  assert.equal(judge([still(1)], { createdAt: ago(25) }).confirmed, false, 'the reporter is outside the window');
  assert.equal(judge([still(1), still(3)], { createdAt: ago(25) }).confirmed, true, 'two recent voters agree');
});

test('a proven check-in counts double, and a low-trust reporter needs one more', () => {
  assert.equal(judge([], { weight: 2 }).confirmed, true, 'someone at the venue counts as two');
  assert.equal(judge([still(1)], { requiredAgreement: 3 }).confirmed, false);
  assert.equal(judge([still(1), still(2)], { requiredAgreement: 3 }).confirmed, true);
  assert.equal(requiredAgreementFor({ confirmed: 0, refuted: 1 }), 2, 'one wrong report is not a pattern');
  assert.equal(requiredAgreementFor({ confirmed: 1, refuted: 2 }), 3);
  assert.equal(requiredAgreementFor({ confirmed: 3, refuted: 2 }), 2);
});

test('gone votes after the latest agreement remove it: two if unconfirmed, three if confirmed', () => {
  assert.equal(judge([gone(1)]).removed, false);
  assert.equal(judge([gone(1), gone(0)]).removed, true);
  assert.equal(judge([still(1.5), gone(1), gone(0)]).confirmed, true);
  assert.equal(judge([still(1.5), gone(1), gone(0)]).removed, false, 'confirmed, and only two gone');
  assert.equal(judge([still(1.5), gone(1), gone(0.5), gone(0.2)], { confirmedAt: ago(1) }).removed, true);
  assert.equal(judge([gone(1.8), gone(1.5), still(1)]).removed, false, 'an agreement after them resets the count');
});

test('expiry is thirty minutes after the latest agreement, at most two hours after the report', () => {
  assert.equal(judge([]).expiresAt.getTime(), ago(2).getTime() + REPORT_LIFETIME_MS);
  assert.equal(judge([still(1)]).expiresAt.getTime(), ago(1).getTime() + REPORT_LIFETIME_MS);
  const old = ago(110);
  assert.equal(judge([still(1)], { createdAt: old }).expiresAt.getTime(), old.getTime() + MAX_REPORT_AGE_MS);
});

// ── Routes ─────────────────────────────────────────────

const createCaller = createCallerFactory(appRouter);
const as = (userId: string | null): Context => ({
  user: userId ? { userId, email: `${userId}@bytspot.com` } : null,
  clientRateLimitKey: `test-map-${userId}`,
});
const member = (id = 'me') => createCaller(as(id));

const user = db.user as any;
const report = db.mapReport as any;
const vote = db.mapReportVote as any;
const venue = db.venue as any;
const checkIn = db.checkIn as any;
const points = db.pointTransaction as any;

type Row = Record<string, any>;
let rows: Row[];
let writes: { op: string; args: any }[];
let changes: MapReportChange[];
let verified: boolean;
const rec = (op: string, result: (args: any) => unknown) => async (args: any) => { writes.push({ op, args }); return result(args); };

const row = (over: Row = {}): Row => ({
  id: 'r1', reporterId: 'reporter', kind: 'police', lat: 33.78, lng: -84.38, venueId: null,
  weight: 1, requiredAgreement: 2, confirmedAt: null, removedAt: null, pointsEarned: 0,
  expiresAt: new Date(Date.now() + 20 * MIN), createdAt: new Date(Date.now() - 2 * MIN), venue: null, votes: [], ...over,
});

onMapReportChange((change) => changes.push(change));

beforeEach(() => {
  resetLocalRateLimitForTests();
  rows = [];
  writes = [];
  changes = [];
  verified = true;
  user.findUnique = async () => ({ emailVerifiedAt: verified ? new Date() : null });
  venue.findUnique = async ({ where }: any) => (where.id === 'v1' ? { id: 'v1', lat: 33.78, lng: -84.38 } : null);
  checkIn.findFirst = async () => null;
  report.count = async () => 0;
  report.findMany = async () => rows.filter((r) => !r.removedAt);
  report.findFirst = async ({ where }: any) => rows.find((r) => r.id === where.id && !r.removedAt) ?? null;
  report.findUnique = async ({ where }: any) => (where.id ? rows.find((r) => r.id === where.id) ?? null : null);
  report.create = rec('report.create', ({ data }) => { rows.push(row({ ...data, id: 'new', votes: [] })); return { id: 'new' }; });
  report.update = rec('report.update', ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id)!, data));
  report.updateMany = rec('report.updateMany', ({ where, data }) => {
    const target = rows.find((r) => r.id === where.id && r.confirmedAt === null);
    if (target) Object.assign(target, data);
    return { count: target ? 1 : 0 };
  });
  report.aggregate = async () => ({ _sum: { pointsEarned: 0 } });
  vote.upsert = rec('vote.upsert', ({ create }) => {
    const target = rows.find((r) => r.id === create.reportId)!;
    target.votes = target.votes.filter((v: Row) => v.voterId !== create.voterId).concat({ ...create });
    return {};
  });
  points.create = rec('points.create', () => ({}));
  (db as any).$transaction = async (ops: Promise<unknown>[]) => Promise.all(ops);
});

const at = { lat: 33.78, lng: -84.38 };

test('reporting needs a confirmed email', async () => {
  verified = false;
  await assert.rejects(() => member().mapReports.submit({ kind: 'police', ...at }), { code: 'FORBIDDEN', message: 'Confirm your email to report on the Map.' });
  rows.push(row());
  await assert.rejects(() => member().mapReports.vote({ reportId: 'r1', vote: 'still' }), { code: 'FORBIDDEN' });
});

test('a new report is unconfirmed, lives thirty minutes and is pushed to the Map', async () => {
  const result = await member().mapReports.submit({ kind: 'police', ...at });
  assert.equal(result.merged, false);
  assert.equal(result.report.status, 'unconfirmed');
  const created = writes.find((w) => w.op === 'report.create')!.args.data;
  assert.equal(created.reporterId, 'me');
  assert.equal(created.requiredAgreement, 2);
  assert.equal(created.expiresAt.getTime() - created.createdAt.getTime(), REPORT_LIFETIME_MS);
  assert.deepEqual(changes.map((c) => c.type), ['upsert']);
  assert.ok(!writes.some((w) => w.op === 'points.create'), 'nothing is paid before someone else agrees');
});

test("a second member's report of the same thing agrees with it, confirms it and pays the reporter", async () => {
  rows.push(row());
  const result = await member().mapReports.submit({ kind: 'police', lat: 33.7805, lng: -84.38 });
  assert.equal(result.merged, true);
  assert.equal(result.report.status, 'confirmed');
  assert.ok(!writes.some((w) => w.op === 'report.create'), 'no second pin');
  assert.equal(writes.find((w) => w.op === 'vote.upsert')!.args.create.vote, 'still');
  const paid = writes.find((w) => w.op === 'points.create')!.args.data;
  assert.equal(paid.userId, 'reporter');
  assert.equal(paid.amount, CONFIRMED_REPORT_POINTS);
  assert.equal(paid.category, 'map_report');
});

test("the reporter's own repeat returns their report without agreeing with it", async () => {
  rows.push(row({ reporterId: 'me' }));
  const result = await member().mapReports.submit({ kind: 'police', ...at });
  assert.equal(result.merged, false);
  assert.equal(result.report.status, 'unconfirmed');
  assert.ok(!writes.some((w) => w.op === 'vote.upsert' || w.op === 'report.create'));
});

test('a report farther than the merge distance is a new pin', async () => {
  rows.push(row());
  await member().mapReports.submit({ kind: 'police', lat: 33.79, lng: -84.38 });
  assert.ok(writes.some((w) => w.op === 'report.create'));
});

test('a line or packed report needs a venue, and the reporter nearby', async () => {
  await assert.rejects(() => member().mapReports.submit({ kind: 'long_line', ...at }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => member().mapReports.submit({ kind: 'long_line', ...at, venueId: 'nope' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => member().mapReports.submit({ kind: 'long_line', lat: 33.9, lng: -84.38, venueId: 'v1' }), { code: 'BAD_REQUEST' });
  checkIn.findFirst = async () => ({ id: 'c1' });
  const result = await member().mapReports.submit({ kind: 'long_line', lat: 33.781, lng: -84.38, venueId: 'v1' });
  assert.equal(result.report.status, 'confirmed', 'a proven check-in at the venue counts as two');
});

test('a reporter whose reports were mostly voted gone needs three', async () => {
  report.count = async ({ where }: any) => (where.removedAt ? 3 : 1);
  await member().mapReports.submit({ kind: 'police', ...at });
  assert.equal(writes.find((w) => w.op === 'report.create')!.args.data.requiredAgreement, 3);
});

test('two gone votes remove an unconfirmed report and push its removal', async () => {
  rows.push(row());
  await member('a').mapReports.vote({ reportId: 'r1', vote: 'gone' });
  const second = await member('b').mapReports.vote({ reportId: 'r1', vote: 'gone' });
  assert.equal(second.removed, true);
  assert.ok(rows[0].removedAt instanceof Date);
  assert.equal(changes.at(-1)!.type, 'remove');
  await assert.rejects(() => member('c').mapReports.vote({ reportId: 'r1', vote: 'still' }), { code: 'NOT_FOUND' });
});

test("you can't vote on your own report", async () => {
  rows.push(row({ reporterId: 'me' }));
  await assert.rejects(() => member().mapReports.vote({ reportId: 'r1', vote: 'still' }), { code: 'BAD_REQUEST' });
});

test('points are paid once, within the daily ceiling', async () => {
  rows.push(row({ confirmedAt: new Date() }));
  await member('a').mapReports.vote({ reportId: 'r1', vote: 'still' });
  assert.ok(!writes.some((w) => w.op === 'points.create'), 'already confirmed: no second payment');

  rows = [row({ id: 'r2' })];
  report.aggregate = async () => ({ _sum: { pointsEarned: 25 } });
  await member('a').mapReports.vote({ reportId: 'r2', vote: 'still' });
  assert.equal(rows[0].confirmedAt instanceof Date, true);
  assert.ok(!writes.some((w) => w.op === 'points.create'), 'daily ceiling reached');
});

test('guests can list reports; a member sees their own and their vote, never who reported', async () => {
  rows.push(row({ votes: [{ voterId: 'me', vote: 'still', weight: 1, votedAt: new Date() }] }));
  const guest = await createCaller(as(null)).mapReports.list({ ...at });
  assert.equal(guest.reports.length, 1);
  assert.equal(guest.reports[0].mine, false);
  assert.equal(guest.reports[0].myVote, null);
  assert.equal('reporterId' in guest.reports[0], false);
  const mine = await member().mapReports.list({ ...at });
  assert.equal(mine.reports[0].myVote, 'still');
  assert.equal(mine.reports[0].status, 'confirmed');
});
