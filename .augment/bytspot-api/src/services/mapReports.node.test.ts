import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import express from 'express';
import mapReportsHttpRouter from '../routes/mapReports';
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
  reportHeadline,
  reporterStanding,
  requiredAgreementFor,
  type MapReportChange,
  type ReportVote,
} from './mapReports';
import { busyStopMessage, nextStopItemId, planIsLive } from './mapReportAlerts';
import { readRelayedPayload, relayPublicKey, verifyRelaySignature } from './mapReportRelay';
import type { PlanLeg } from './planLegs';

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
const planItem = db.planItem as any;
const plan = db.plan as any;
const pushDevice = db.iOSPushDevice as any;
const relayKey = db.mapReportRelayKey as any;

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
  planItem.findMany = async () => [];
  plan.findMany = async () => [];
  pushDevice.findMany = rec('push.devices', () => []);
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

// ── Phase D: badge, plan alerts, share page ────────────

const midtown = { lat: 33.7838, lng: -84.383 };
const elsewhere = { lat: 34.2, lng: -84.1 };

test('"Top Midtown reporter" goes to the most confirmed reports there this week, from three, ties shared', () => {
  const confirmed = (reporterId: string, count: number, at = midtown) => Array.from({ length: count }, () => ({ reporterId, ...at }));
  assert.deepEqual(reporterStanding('me', [...confirmed('me', 3), ...confirmed('other', 2)]), { confirmedThisWeek: 3, badge: 'Top Midtown reporter' });
  assert.equal(reporterStanding('me', [...confirmed('me', 3), ...confirmed('other', 4)]).badge, null, 'someone has more');
  assert.equal(reporterStanding('me', [...confirmed('me', 3), ...confirmed('other', 3)]).badge, 'Top Midtown reporter', 'a tie is shared');
  assert.equal(reporterStanding('me', confirmed('me', 2)).badge, null, 'fewer than three');
  assert.deepEqual(reporterStanding('me', confirmed('me', 5, elsewhere)), { confirmedThisWeek: 5, badge: null }, 'outside a named area');
});

test('standing reads the past week of confirmed reports', async () => {
  let where: any;
  report.findMany = async (args: any) => { where = args.where; return [{ reporterId: 'me', ...midtown }, { reporterId: 'me', ...midtown }, { reporterId: 'me', ...midtown }]; };
  assert.deepEqual(await member().mapReports.standing(), { confirmedThisWeek: 3, badge: 'Top Midtown reporter' });
  assert.ok(Date.now() - where.confirmedAt.gte.getTime() >= 7 * 24 * 60 * MIN - 1000);
  assert.deepEqual(where.reporter, { suspendedAt: null, deletedAt: null });
  await assert.rejects(() => createCaller(as(null)).mapReports.standing(), { code: 'UNAUTHORIZED' });
});

test('reports carry their area, headline and a share link', async () => {
  rows.push(row({ ...midtown }), row({ id: 'r2', kind: 'packed', venueId: 'v1', venue: { name: 'Ponce City Market' }, ...elsewhere }));
  const { reports } = await createCaller(as(null)).mapReports.list({ ...midtown, radiusMiles: 5 });
  const police = reports.find((r) => r.id === 'r1')!;
  assert.equal(police.area, 'Midtown');
  assert.match(police.shareUrl, /\/alert\/r1$/);
  assert.equal(reportHeadline('packed', 'Ponce City Market'), 'Ponce City Market is packed');
  assert.equal(reportHeadline('long_line', null), 'Long line reported');
  assert.equal(reportHeadline('police', 'Anywhere'), 'Police reported');
});

const leg = (itemId: string, startsAt: Date | null): PlanLeg => ({
  itemId, position: null, needKind: 'nightlife', title: itemId, startsAt, durationMins: null, latitude: null, longitude: null, priceCents: null, seats: null,
});

test("a plan's next stop is the first that hasn't started, and a plan is live from three hours before", () => {
  const t = new Date('2026-10-11T22:00:00Z');
  assert.equal(nextStopItemId([leg('a', ago(30)), leg('b', null), leg('c', null)], now), 'b');
  assert.equal(nextStopItemId([leg('a', ago(30))], now), null);
  const live = { lifecycle: 'confirmed', startsAt: t, endsAt: null, expiresAt: null, deletedAt: null };
  assert.equal(planIsLive({ ...live, startsAt: new Date(t.getTime() + 2 * 60 * MIN) }, t), true);
  assert.equal(planIsLive({ ...live, startsAt: new Date(t.getTime() + 4 * 60 * MIN) }, t), false, 'too far ahead');
  assert.equal(planIsLive({ ...live, startsAt: new Date(t.getTime() - 9 * 60 * MIN) }, t), false, 'over, with no stated end');
  assert.equal(planIsLive({ ...live, lifecycle: 'cancelled' }, t), false);
  assert.equal(planIsLive({ ...live, startsAt: null }, t), false, 'no time, no next stop');
  assert.equal(busyStopMessage('packed', 'MJQ').title, 'Your next stop just got packed');
});

test('confirming a packed report alerts the members going whose next stop it is, not those who reported', async () => {
  venue.findUnique = async ({ where, select }: any) => (where.id === 'v1' ? (select?.googlePlaceId ? { googlePlaceId: 'gp1' } : { id: 'v1', lat: 33.78, lng: -84.38 }) : null);
  let itemWhere: any;
  planItem.findMany = async (args: any) => { itemWhere = args.where; return [{ id: 'stop', planId: 'p1' }, { id: 'later', planId: 'p2' }]; };
  const item = (id: string, position: number, startsAt: Date | null) => ({ id, position, createdAt: new Date(), needKind: 'nightlife', title: id, party: startsAt ? { startsAt, endsAt: null, lat: null, lng: null, capacity: null } : null, offer: null });
  plan.findMany = async () => [
    { id: 'p1', lifecycle: 'confirmed', startsAt: new Date(Date.now() - 60 * MIN), endsAt: null, expiresAt: null, deletedAt: null,
      items: [item('dinner', 0, new Date(Date.now() - 60 * MIN)), item('stop', 1, null)],
      participants: [{ userId: 'friend' }, { userId: 'reporter' }] },
    { id: 'p2', lifecycle: 'confirmed', startsAt: new Date(Date.now() - 60 * MIN), endsAt: null, expiresAt: null, deletedAt: null,
      items: [item('first', 0, null), item('later', 1, null)],
      participants: [{ userId: 'other' }] },
  ];
  rows.push(row({ kind: 'packed', venueId: 'v1', venue: { name: 'MJQ' } }));
  await member('me').mapReports.vote({ reportId: 'r1', vote: 'still' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(itemWhere.OR, [{ party: { arrivalVenueId: 'v1' } }, { placeId: 'gp1' }]);
  const pushed = writes.filter((w) => w.op === 'push.devices').map((w) => w.args.where.userId.in);
  assert.deepEqual(pushed, [['friend']], 'p2 is heading elsewhere first; the reporter already knows');
});

test('a police report confirmation alerts no plan', async () => {
  let looked = false;
  planItem.findMany = async () => { looked = true; return []; };
  rows.push(row());
  await member('me').mapReports.vote({ reportId: 'r1', vote: 'still' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(looked, false);
});

async function getAlert(id: string): Promise<{ status: number; html: string; cache: string | null; csp: string | null }> {
  const app = express();
  app.use(mapReportsHttpRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/alert/${id}`);
    return { status: res.status, html: await res.text(), cache: res.headers.get('cache-control'), csp: res.headers.get('content-security-policy') };
  } finally {
    server.close();
  }
}

test('a shared report opens a page anyone can read, naming the area and never the reporter', async () => {
  rows.push(row({ kind: 'long_line', venueId: 'v1', venue: { name: 'Ponce <City> Market' }, ...midtown, votes: [{ voterId: 'friend', vote: 'still', weight: 1, votedAt: new Date() }] }));
  const page = await getAlert('r1');
  assert.equal(page.status, 200);
  assert.match(page.html, /<meta property="og:title" content="Midtown: Long line at Ponce &lt;City&gt; Market">/);
  assert.match(page.html, /Confirmed/);
  assert.match(page.html, /2 min ago/);
  assert.match(page.html, /apps\.apple\.com\/app\/id6761876421/);
  assert.doesNotMatch(page.html, /reporter|friend/);
  assert.doesNotMatch(page.html, /<script/);
  assert.equal(page.cache, 'public, max-age=60');
  assert.match(page.csp!, /default-src 'none'/);
});

test('an expired, removed or unknown report reads as ended', async () => {
  rows.push(row({ id: 'gone', votes: [{ voterId: 'a', vote: 'gone', weight: 1, votedAt: new Date() }, { voterId: 'b', vote: 'gone', weight: 1, votedAt: new Date() }] }));
  for (const id of ['gone', 'nope']) {
    const page = await getAlert(id);
    assert.equal(page.status, 404);
    assert.match(page.html, /This alert has ended/);
    assert.equal(page.cache, 'no-store');
  }
});

// ── Phase E: reports carried by nearby phones ──────────

function phoneKey(): { publicKey: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: raw.toString('base64'), privateKey: pair.privateKey };
}

const phone = phoneKey();
const signed = (payload: Record<string, unknown>, key = phone.privateKey, keyId = 'k1') => {
  const text = JSON.stringify({ v: 1, keyId, clientReportId: 'relay-0001', kind: 'police', ...at, reportedAt: new Date(Date.now() - 5 * MIN).toISOString(), ...payload });
  return { keyId, payload: text, signature: sign('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }).toString('base64') };
};

test('a relayed report must be signed by its key, name that key and be under thirty minutes old', () => {
  const ok = signed({});
  assert.equal(verifyRelaySignature(phone.publicKey, ok.payload, ok.signature), true);
  assert.equal(verifyRelaySignature(phone.publicKey, ok.payload.replace('police', 'incident'), ok.signature), false, 'changed after signing');
  assert.equal(verifyRelaySignature(phoneKey().publicKey, ok.payload, ok.signature), false, 'another phone');
  assert.equal(relayPublicKey('not a key'), null);
  assert.equal(relayPublicKey(Buffer.alloc(65, 4).toString('base64')), null, 'not a point on the curve');
  assert.ok(readRelayedPayload(ok.payload, 'k1', new Date()));
  assert.equal(readRelayedPayload(ok.payload, 'k2', new Date()), null, 'signed for another key');
  assert.equal(readRelayedPayload(signed({ reportedAt: new Date(Date.now() - 31 * MIN).toISOString() }).payload, 'k1', new Date()), null, 'too old');
  assert.equal(readRelayedPayload(signed({ reportedAt: new Date(Date.now() + 10 * MIN).toISOString() }).payload, 'k1', new Date()), null, 'from the future');
  assert.equal(readRelayedPayload('{nope', 'k1', new Date()), null);
});

test('a phone registers its key once; a key belongs to one member, and five are kept', async () => {
  const keys: Row[] = [];
  relayKey.findUnique = async ({ where }: any) => keys.find((k) => k.publicKey === where.publicKey) ?? null;
  relayKey.create = rec('key.create', ({ data }) => { const key = { id: `k${keys.length + 1}`, ...data }; keys.push(key); return { id: key.id }; });
  relayKey.findMany = async () => [{ id: 'old' }];
  relayKey.deleteMany = rec('key.deleteMany', () => ({ count: 1 }));

  await assert.rejects(() => member().mapReports.registerRelayKey({ publicKey: 'abc' }), { code: 'BAD_REQUEST' });
  assert.deepEqual(await member().mapReports.registerRelayKey({ publicKey: phone.publicKey }), { keyId: 'k1' });
  assert.deepEqual(writes.find((w) => w.op === 'key.deleteMany')!.args.where, { id: { in: ['old'] } });
  assert.deepEqual(await member().mapReports.registerRelayKey({ publicKey: phone.publicKey }), { keyId: 'k1' }, 'again, same id');
  assert.equal(writes.filter((w) => w.op === 'key.create').length, 1);
  await assert.rejects(() => member('someone').mapReports.registerRelayKey({ publicKey: phone.publicKey }), { code: 'CONFLICT' });
});

test('a carried report is filed as its reporter, at the time they made it, and the carrier earns nothing', async () => {
  let keyWhere: any;
  relayKey.findMany = async ({ where }: any) => { keyWhere = where; return [{ id: 'k1', userId: 'reporter', publicKey: phone.publicKey }]; };
  const report5 = signed({});
  const { results } = await member('carrier').mapReports.relay({ reports: [report5] });
  assert.equal(results[0].status, 'accepted');
  assert.equal(results[0].clientReportId, 'relay-0001');
  const created = writes.find((w) => w.op === 'report.create')!.args.data;
  assert.equal(created.reporterId, 'reporter');
  assert.equal(created.clientReportId, 'relay-0001');
  assert.equal(created.createdAt.toISOString(), JSON.parse(report5.payload).reportedAt);
  assert.equal(created.expiresAt.getTime() - created.createdAt.getTime(), REPORT_LIFETIME_MS);
  assert.deepEqual(keyWhere.user, { suspendedAt: null, deletedAt: null });
  assert.ok(!JSON.stringify(writes).includes('carrier'), 'nothing is recorded for the carrier');
});

test('a changed, unknown or wrongly keyed report is rejected without failing the others', async () => {
  relayKey.findMany = async () => [{ id: 'k1', userId: 'reporter', publicKey: phone.publicKey }];
  const tampered = signed({});
  tampered.payload = tampered.payload.replace('police', 'incident');
  const unknownKey = signed({}, phone.privateKey, 'k9');
  const swapped = { ...signed({ clientReportId: 'relay-0002' }), keyId: 'k1' };
  swapped.payload = swapped.payload.replace('"keyId":"k1"', '"keyId":"k2"');
  const good = signed({ clientReportId: 'relay-0003' });
  const { results } = await member('carrier').mapReports.relay({ reports: [tampered, unknownKey, swapped, good] });
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected', 'accepted']);
  assert.equal(writes.filter((w) => w.op === 'report.create').length, 1);
});

test('a report already filed is accepted again without a second pin, and the hourly limit applies to new ones', async () => {
  relayKey.findMany = async () => [{ id: 'k1', userId: 'reporter', publicKey: phone.publicKey }];
  rows.push(row({ reporterId: 'reporter', clientReportId: 'relay-0001' }));
  report.findUnique = async ({ where }: any) => (where.id
    ? rows.find((r) => r.id === where.id) ?? null
    : rows.find((r) => r.reporterId === where.reporterId_clientReportId.reporterId && r.clientReportId === where.reporterId_clientReportId.clientReportId) ?? null);
  report.count = async () => 10;
  const { results } = await member('carrier').mapReports.relay({ reports: [signed({}), signed({ clientReportId: 'relay-0002' })] });
  assert.equal(results[0].status, 'accepted');
  assert.equal(results[0].report!.id, 'r1');
  assert.deepEqual(results[1], { clientReportId: 'relay-0002', status: 'rejected', message: 'Too many reports from this member.' });
  assert.ok(!writes.some((w) => w.op === 'report.create'));
  await assert.rejects(() => createCaller(as(null)).mapReports.relay({ reports: [signed({})] }), { code: 'UNAUTHORIZED' });
});
