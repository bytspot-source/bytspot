import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { closeBlockers, closeSeller, createSellerWithOwner, pauseSeller, renewOwnerInvite, restoreSeller, VendorDecisionRefused } from './adminDecisions';

const restores: Array<() => void> = [];
function stub(target: any, key: string, implementation: (...args: any[]) => any) {
  const original = target[key]; target[key] = implementation;
  restores.push(() => { target[key] = original; });
}
const now = new Date('2026-11-09T18:00:00.000Z');
let seller: any, writes: any[], counts: { tickets: number; settling: number; payouts: number }, offers: any[];

beforeEach(() => {
  writes = []; offers = []; counts = { tickets: 0, settling: 0, payouts: 0 };
  seller = { id: 's1', legalName: 'Kitchen', contactEmail: 'owner@example.test', state: 'ACTIVE', approvedAt: now, pausedReason: null };
  stub(db.vendorSeller, 'findUnique', async () => seller);
  stub(db.vendorSeller, 'findUniqueOrThrow', async () => seller);
  stub(db.vendorSeller, 'updateMany', async (args: any) => {
    writes.push({ op: 'seller', ...args });
    const matches = Object.entries(args.where).every(([key, value]: [string, any]) =>
      key === 'id' || (value && typeof value === 'object' && 'in' in value ? value.in.includes(seller[key]) : seller[key] === value));
    if (!matches) return { count: 0 };
    seller = { ...seller, ...args.data };
    return { count: 1 };
  });
  stub(db.vendorLocation, 'updateMany', async (args: any) => { writes.push({ op: 'location', ...args }); return { count: 1 }; });
  stub(db.offer, 'findMany', async () => offers);
  stub(db.vendorTicketOrder, 'count', async (args: any) => (args.where.status === 'settling' ? counts.settling : counts.tickets));
  stub(db.partyPayoutTransfer, 'count', async () => counts.payouts);
  stub(db as any, '$transaction', async (run: any) => run(db));
});
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });

test('pausing a live business suspends it and keeps a trimmed reason', async () => {
  const paused = await pauseSeller('s1', 'admin', '  Health permit expired  ', now);
  assert.equal(paused.state, 'SUSPENDED');
  assert.equal(paused.pausedReason, 'Health permit expired');
  assert.equal(paused.pausedByUserId, 'admin');
  await assert.rejects(() => pauseSeller('s1', 'admin', null, now), (error: any) => error instanceof VendorDecisionRefused && error.code === 'CONFLICT');
});

test('pausing a business that is not live yet withdraws its approval instead', async () => {
  seller.state = 'PENDING';
  const paused = await pauseSeller('s1', 'admin', null, now);
  assert.equal(paused.state, 'PENDING');
  assert.equal(paused.approvedAt, null);
  assert.equal(paused.pausedReason, null);
  await assert.rejects(() => pauseSeller('s1', 'admin', null, now), { code: 'CONFLICT' });
});

test('restore lifts only a pause and clears the reason', async () => {
  await assert.rejects(() => restoreSeller('s1'), { code: 'CONFLICT' });
  seller = { ...seller, state: 'SUSPENDED', pausedAt: now, pausedReason: 'x' };
  const restored = await restoreSeller('s1');
  assert.equal(restored.state, 'ACTIVE');
  assert.equal(restored.pausedReason, null);
});

test('a closed business reads as missing to every decision', async () => {
  seller.state = 'CLOSED';
  for (const run of [() => pauseSeller('s1', 'a', null), () => restoreSeller('s1'), () => closeSeller('s1', 'a', 'Kitchen'), () => renewOwnerInvite('s1')]) {
    await assert.rejects(run, { code: 'NOT_FOUND' });
  }
});

test('close needs the typed name and changes nothing while something still needs the business', async () => {
  await assert.rejects(() => closeSeller('s1', 'admin', 'Kitchn', now), { code: 'BAD_REQUEST' });
  offers = [
    { startsAt: new Date(now.getTime() + 3_600_000), durationMins: 60 },
    { startsAt: new Date(now.getTime() - 3 * 3_600_000), durationMins: 60 },
  ];
  counts = { tickets: 2, settling: 1, payouts: 1 };
  const refused = await closeSeller('s1', 'admin', ' kitchen ', now);
  assert.deepEqual(refused.blockers, [
    '1 upcoming booking', '2 tickets for events that have not ended', '1 ticket payment still settling', '1 party payout not yet paid',
  ]);
  assert.equal(writes.length, 0);
  assert.equal(seller.state, 'ACTIVE');
});

test('close with nothing pending closes, stamps the admin and frees the venue binding', async () => {
  assert.deepEqual(await closeBlockers('s1', now), []);
  const { seller: closed, blockers } = await closeSeller('s1', 'admin', 'Kitchen', now);
  assert.deepEqual(blockers, []);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(closed.closedByUserId, 'admin');
  const unbind = writes.find((write) => write.op === 'location');
  assert.deepEqual(unbind.where, { sellerId: 's1' });
  assert.deepEqual(unbind.data, { menuVenueId: null });
});

test('create invites the owner by normalized email and refuses a duplicate', async () => {
  stub(db.user, 'findUnique', async () => ({ id: 'u1' }));
  let duplicate: any = null;
  stub(db.vendorSeller, 'findFirst', async () => duplicate);
  let created: any;
  stub(db.vendorSeller, 'create', async (args: any) => { created = args.data; return { id: 's2', ...args.data }; });
  const { email } = await createSellerWithOwner({ legalName: ' Kitchen ', email: ' Owner@Example.test ' }, 'admin', now);
  assert.equal(email, 'owner@example.test');
  assert.equal(created.legalName, 'Kitchen');
  assert.equal(created.createdByUserId, 'admin');
  assert.deepEqual(created.seats.create, { userId: 'u1', role: 'owner', state: 'INVITED', invitedAt: now });
  assert.equal('state' in created, false, 'starts as a draft; going live still needs approval');
  await assert.rejects(() => createSellerWithOwner({ legalName: 'Kitchen', email: 'not-an-email' }, 'admin'), { code: 'BAD_REQUEST' });
  duplicate = { id: 's1' };
  await assert.rejects(() => createSellerWithOwner({ legalName: 'Kitchen', email: 'owner@example.test' }, 'admin'), { code: 'CONFLICT' });
});

test('resending refreshes the waiting owner invite only', async () => {
  let seat: any = null;
  stub(db.vendorSeat, 'findFirst', async () => seat);
  let updated: any;
  stub(db.vendorSeat, 'update', async (args: any) => { updated = args; return {}; });
  await assert.rejects(() => renewOwnerInvite('s1', now), { code: 'CONFLICT' });
  seat = { id: 'seat', user: { email: 'owner@example.test' } };
  assert.equal((await renewOwnerInvite('s1', now)).email, 'owner@example.test');
  assert.deepEqual(updated, { where: { id: 'seat' }, data: { invitedAt: now } });
});
