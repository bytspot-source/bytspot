import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import { config } from '../config';
import { applyDeletionPolicyOnSignIn } from '../services/accountDeletion';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const user = db.user as any;
const block = db.userBlock as any;
const report = db.contentReport as any;
const party = db.party as any;
const review = db.review as any;
const sale = db.privateSale as any;

const as = (userId: string): Context => ({
  user: { userId, email: `${userId}@bytspot.com` },
  clientRateLimitKey: `test-safety-${userId}`,
});
const member = (id = 'me') => createCaller(as(id));
(config as any).adminUserIds = 'admin-id:BYTSPOT_ADMIN';
(config as any).safetyAlertEmail = '';
const admin = () => createCaller(as('admin-id'));

let writes: { op: string; args: any }[];
const record = (op: string, result: unknown) => async (args: any) => { writes.push({ op, args }); return result; };

beforeEach(() => {
  resetLocalRateLimitForTests();
  writes = [];
  user.findUnique = async ({ where }: any) => (where.id === 'nobody' ? null : { id: where.id });
  user.findFirst = async ({ where }: any) => ({ id: where.id, name: 'Ama', profileImage: null });
  user.findMany = async () => [];
  user.updateMany = record('user.updateMany', { count: 1 });
  block.findUnique = async () => null;
  block.findMany = async () => [];
  block.findFirst = async () => null;
  block.count = async () => 0;
  block.upsert = record('block.upsert', {});
  block.deleteMany = record('block.deleteMany', { count: 1 });
  (db.socialInvitation as any).deleteMany = record('invites.deleteMany', { count: 0 });
  (db.follow as any).deleteMany = record('follows.deleteMany', { count: 0 });
  (db.socialCircleMember as any).deleteMany = record('circles.deleteMany', { count: 0 });
  (db.privateSaleRequest as any).updateMany = record('saleRequests.updateMany', { count: 0 });
  (db.planParticipant as any).updateMany = record('planSeats.updateMany', { count: 0 });
  (db as any).$transaction = async (ops: Promise<unknown>[]) => Promise.all(ops);
  report.create = record('report.create', {});
  report.count = async () => 1;
  report.findFirst = async () => ({ ownerId: 'host-id' });
  report.findMany = async () => [];
  report.groupBy = async () => [];
  report.updateMany = record('report.updateMany', { count: 2 });
  party.findFirst = async () => ({ hostUserId: 'host-id', title: 'Rooftop', tagline: 'Late', venueName: 'Ponce City', startsAt: new Date(), media: [{ id: 'm1' }] });
  party.updateMany = record('party.updateMany', { count: 1 });
  party.findMany = async () => [];
  review.findUnique = async () => ({ userId: 'reviewer-id', stars: 1, vibe: 1, comment: 'awful', venue: { name: 'Bar' } });
  review.updateMany = record('review.updateMany', { count: 1 });
  review.findMany = async () => [];
  sale.updateMany = record('sale.updateMany', { count: 1 });
  sale.findMany = async () => [];
});

test('blocking clears everything pending between the two, in both directions', async () => {
  assert.deepEqual(await member().safety.block({ userId: 'them' }), { blocked: true });
  const ops = writes.map((w) => w.op);
  assert.deepEqual(ops, ['block.upsert', 'invites.deleteMany', 'follows.deleteMany', 'circles.deleteMany', 'saleRequests.updateMany', 'planSeats.updateMany']);
  const invites = writes.find((w) => w.op === 'invites.deleteMany')!.args.where;
  assert.deepEqual(invites.status, { in: ['pending', 'accepted'] }, 'a declined row stays so an unblock never resurfaces it');
  assert.equal(invites.OR.length, 2);
  const requests = writes.find((w) => w.op === 'saleRequests.updateMany')!.args;
  assert.deepEqual(requests.where.status, { in: ['pending', 'approved'] }, 'an approved buyer loses the meet point too');
  assert.equal(requests.data.status, 'declined');
  const seats = writes.find((w) => w.op === 'planSeats.updateMany')!.args;
  assert.equal(seats.where.status, 'invited', 'confirmed Plan seats stay');
});

test('blocking refuses yourself, unknown members and the limit', async () => {
  await assert.rejects(() => member().safety.block({ userId: 'me' }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => member().safety.block({ userId: 'nobody' }), { code: 'NOT_FOUND' });
  block.count = async () => 1000;
  await assert.rejects(() => member().safety.block({ userId: 'them' }), { code: 'BAD_REQUEST' });
  block.findUnique = async () => ({ id: 'existing' });
  assert.deepEqual(await member().safety.block({ userId: 'them' }), { blocked: true }, 'blocking again at the limit is fine');
});

test('a host, reviewer or seller can be blocked by the item, without their account id', async () => {
  assert.deepEqual(await member().safety.block({ kind: 'party', targetId: 'p1' }), { blocked: true });
  assert.deepEqual(writes.find((w) => w.op === 'block.upsert')!.args.create, { blockerId: 'me', blockedId: 'host-id' });
  party.findFirst = async () => null;
  await assert.rejects(() => member().safety.block({ kind: 'party', targetId: 'gone' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => member('reviewer-id').safety.block({ kind: 'review', targetId: 'r1' }), { code: 'BAD_REQUEST' });
});

test('the blocks list shows only who this member blocked', async () => {
  let where: any;
  block.findMany = async (args: any) => { where = args.where; return [{ createdAt: new Date(0), blocked: { id: 'them', name: '  ' } }]; };
  const { blocks } = await member().safety.blocks();
  assert.deepEqual(where, { blockerId: 'me' });
  assert.deepEqual(blocks, [{ userId: 'them', name: 'Bytspot member', blockedAt: new Date(0).toISOString() }]);
  await member().safety.unblock({ userId: 'them' });
  assert.deepEqual(writes.at(-1)!.args.where, { blockerId: 'me', blockedId: 'them' });
});

test('a report stores a snapshot and never hides anything on one report', async () => {
  assert.deepEqual(await member().safety.report({ kind: 'party', targetId: 'p1', reason: 'spam', note: ' scam link ' }), { reported: true });
  const created = writes.find((w) => w.op === 'report.create')!.args.data;
  assert.equal(created.ownerId, 'host-id');
  assert.equal(created.note, 'scam link');
  assert.equal(created.snapshot.title, 'Rooftop');
  assert.deepEqual(created.snapshot.mediaIds, ['m1']);
  assert.equal(writes.some((w) => w.op === 'party.updateMany'), false);
});

test('three open reports from confirmed emails hide the item until an admin decides', async () => {
  let counted: any;
  report.count = async ({ where }: any) => { counted = where; return 3; };
  await member().safety.report({ kind: 'review', targetId: 'r1', reason: 'harassment' });
  assert.deepEqual(counted.reporter, { emailVerifiedAt: { not: null } });
  assert.equal(counted.status, 'open');
  const hide = writes.find((w) => w.op === 'review.updateMany')!.args;
  assert.deepEqual(hide.where, { id: 'r1', moderationHiddenAt: null });
  assert.ok(hide.data.moderationHiddenAt instanceof Date);
});

test('a person is never auto-hidden, only queued', async () => {
  report.count = async () => 10;
  await member().safety.report({ kind: 'user', targetId: 'them', reason: 'impersonation' });
  assert.equal(writes.some((w) => w.op.endsWith('updateMany')), false);
});

test('a repeat report is accepted and not counted again; yourself and missing items are refused', async () => {
  report.create = async () => { throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }); };
  report.count = async () => { throw new Error('a repeat must not recount'); };
  assert.deepEqual(await member().safety.report({ kind: 'party', targetId: 'p1', reason: 'spam' }), { reported: true });
  await assert.rejects(() => member('host-id').safety.report({ kind: 'party', targetId: 'p1', reason: 'spam' }), { code: 'BAD_REQUEST' });
  party.findFirst = async () => null;
  await assert.rejects(() => member().safety.report({ kind: 'party', targetId: 'gone', reason: 'spam' }), { code: 'NOT_FOUND' });
});

test('only admins see and decide reports', async () => {
  await assert.rejects(() => member().admin.safety.reports(), { code: 'FORBIDDEN' });
  await assert.rejects(() => member().admin.safety.decide({ kind: 'party', targetId: 'p1', action: 'dismiss' }), { code: 'FORBIDDEN' });
});

test('the queue groups reports by item, oldest first, with the owner history', async () => {
  report.findMany = async ({ where, orderBy }: any) => {
    assert.deepEqual(where, { status: 'open' });
    assert.deepEqual(orderBy, { createdAt: 'asc' });
    return [
      { targetKind: 'party', targetId: 'p1', ownerId: 'host-id', reason: 'spam', note: null, snapshot: { title: 'Rooftop' }, status: 'open', decidedAt: null, createdAt: new Date(1) },
      { targetKind: 'party', targetId: 'p1', ownerId: 'host-id', reason: 'violence', note: 'threats', snapshot: { title: 'Rooftop' }, status: 'open', decidedAt: null, createdAt: new Date(2) },
    ];
  };
  user.findMany = async () => [{ id: 'host-id', name: 'Host', email: 'host@bytspot.com', createdAt: new Date(0), suspendedAt: null }];
  report.groupBy = async () => [{ ownerId: 'host-id', status: 'open', _count: { _all: 2 } }, { ownerId: 'host-id', status: 'removed', _count: { _all: 1 } }];
  party.findMany = async () => [{ id: 'p1' }];
  const { items } = await admin().admin.safety.reports();
  assert.equal(items.length, 1);
  assert.equal(items[0].reporterCount, 2);
  assert.equal(items[0].hidden, true);
  assert.deepEqual((items[0].owner as any).reportsAgainst, 3);
  assert.deepEqual((items[0].owner as any).actedOn, 1);
});

test('dismiss shows the item again; remove keeps it hidden', async () => {
  assert.deepEqual(await admin().admin.safety.decide({ kind: 'party', targetId: 'p1', action: 'dismiss' }), { status: 'dismissed' });
  assert.deepEqual(writes.find((w) => w.op === 'party.updateMany')!.args.data, { moderationHiddenAt: null });
  assert.equal(writes.find((w) => w.op === 'report.updateMany')!.args.data.decidedById, 'admin-id');

  writes = [];
  assert.deepEqual(await admin().admin.safety.decide({ kind: 'sale', targetId: 's1', action: 'remove' }), { status: 'removed' });
  assert.ok(writes.find((w) => w.op === 'sale.updateMany')!.args.data.moderationHiddenAt instanceof Date);
  assert.equal(writes.some((w) => w.op === 'user.updateMany'), false);

  await assert.rejects(() => admin().admin.safety.decide({ kind: 'user', targetId: 'them', action: 'remove' }), { code: 'BAD_REQUEST' });
  report.findFirst = async () => null;
  await assert.rejects(() => admin().admin.safety.decide({ kind: 'party', targetId: 'p1', action: 'dismiss' }), { code: 'NOT_FOUND' });
});

test('suspending flags the owner, and a suspended account cannot sign in by any route', async () => {
  assert.deepEqual(await admin().admin.safety.decide({ kind: 'party', targetId: 'p1', action: 'suspend' }), { status: 'suspended' });
  const suspended = writes.find((w) => w.op === 'user.updateMany')!.args;
  assert.deepEqual(suspended.where, { id: 'host-id', suspendedAt: null });

  user.findUnique = async () => ({ deletedAt: new Date(), purgeAfter: new Date(Date.now() + 86_400_000), suspendedAt: new Date() });
  user.update = async () => { throw new Error('a suspension must not cancel a pending deletion'); };
  await assert.rejects(() => applyDeletionPolicyOnSignIn('host-id'), { code: 'FORBIDDEN', message: 'This account has been suspended.' });

  user.updateMany = record('user.updateMany', { count: 1 });
  assert.deepEqual(await admin().admin.safety.reinstate({ userId: 'host-id' }), { reinstated: true });
  user.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => admin().admin.safety.reinstate({ userId: 'host-id' }), { code: 'NOT_FOUND' });
});
