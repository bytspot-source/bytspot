import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { requestAllowance, requestWindowState, senderFirstName, tiersWithRequests } from '../services/partyRequestNotes';
import { createCallerFactory, resetLocalRateLimitForTests } from './trpc';
import { partyRequestsRouter } from './partyRequestsRouter';

const callerFactory = createCallerFactory(partyRequestsRouter);
const caller = (userId: string | null = 'guest') => callerFactory({ user: userId ? { userId, email: 'unused@test.invalid' } : null, clientRateLimitKey: 'requests-tests' });
const prisma = db as any;
const notes = db.partyRequestNote as any;
const tiers = [
  { name: 'General', priceCents: 2000, quantity: 50, requiredMembershipTier: 'green' },
  { name: 'VIP', priceCents: 4000, quantity: 10, requiredMembershipTier: 'green', requestNotes: 3 },
];
const hourAgo = new Date(Date.now() - 3600_000);
let liveParty: any;
let guestRow: any;
let credits: any[];
let created: any[];
let updates: any[];
let used: number;
const noteRow = (overrides: any = {}) => ({
  id: 'note', performerId: 'dj', body: 'Play something by Outkast', senderName: 'Ama', status: 'sent', acceptedAt: null, playedAt: null,
  version: 0, createdAt: new Date('2026-10-29T02:00:00Z'), senderUserId: 'guest', performer: { displayName: 'DJ North', role: 'dj' }, ...overrides,
});
const send = (overrides: any = {}) => ({ partyId: 'party', performerId: 'dj', body: 'Play something by Outkast', showName: true, idempotencyKey: '00000000-0000-4000-8000-000000000001', ...overrides });

beforeEach(() => {
  resetLocalRateLimitForTests();
  liveParty = { id: 'party', title: 'Rooftop', hostUserId: 'host', startsAt: hourAgo, endsAt: null, closedAt: null, ticketTiers: tiers };
  guestRow = { status: 'ticketed', accessGranted: true, ticketTierName: 'VIP' };
  credits = [{ id: 'dj', confirmedUserId: 'performer' }];
  created = []; updates = []; used = 0;
  prisma.$transaction = async (fn: any) => fn(db);
  (db.user as any).findFirst = async ({ where }: any) => ({ id: where.id, name: 'Ama Owusu Mensah' });
  (db.party as any).findFirst = async () => liveParty;
  (db.party as any).findUnique = async () => null;
  (db.partyGuest as any).findUnique = async () => guestRow;
  (db.partyPerformer as any).findMany = async ({ where }: any) =>
    credits.filter((credit) => !where.confirmedUserId || credit.confirmedUserId === where.confirmedUserId).map(({ id }) => ({ id, displayName: 'DJ North', role: 'dj' }));
  (db.partyPerformer as any).findFirst = async ({ where }: any) => credits.find((credit) => credit.id === where.id) ?? null;
  notes.findUnique = async () => null;
  notes.count = async () => used;
  notes.create = async ({ data }: any) => { created.push(data); return noteRow({ senderName: data.senderName }); };
  notes.findMany = async () => [noteRow({ status: 'accepted', acceptedAt: new Date() })];
  notes.updateMany = async (args: any) => { updates.push(args); return { count: 1 }; };
  notes.findUniqueOrThrow = async () => noteRow({ status: 'accepted', acceptedAt: new Date(), version: 1 });
});

test('only a Stripe-confirmed ticket on a paid tier that includes requests has an allowance', () => {
  assert.equal(requestAllowance(tiers, guestRow), 3);
  assert.equal(requestAllowance(tiers, { ...guestRow, ticketTierName: 'General' }), 0);
  assert.equal(requestAllowance(tiers, { ...guestRow, status: 'checkout-pending', accessGranted: false }), 0);
  assert.equal(requestAllowance(tiers, { status: 'approved', accessGranted: true, ticketTierName: null }), 0);
  assert.equal(requestAllowance([{ name: 'Free', priceCents: 0, requestNotes: 5 }], { ...guestRow, ticketTierName: 'Free' }), 0);
  assert.equal(requestAllowance([{ name: 'VIP', priceCents: 100, requestNotes: 99 }], guestRow), 5);
  assert.deepEqual(tiersWithRequests(tiers), [{ name: 'VIP', priceCents: 4000, requestNotes: 3 }]);
});

test('requests are open only while the party is on', () => {
  const closesAt = new Date(hourAgo.getTime() + 6 * 3600_000);
  assert.equal(requestWindowState({ startsAt: hourAgo, closedAt: null }, closesAt, new Date()), 'open');
  assert.equal(requestWindowState({ startsAt: hourAgo, closedAt: null }, closesAt, new Date(hourAgo.getTime() - 1)), 'not-started');
  assert.equal(requestWindowState({ startsAt: hourAgo, closedAt: null }, closesAt, closesAt), 'ended');
  assert.equal(requestWindowState({ startsAt: hourAgo, closedAt: new Date() }, closesAt, new Date()), 'closed');
});

test('the sender name is the first word only, or nothing', () => {
  assert.equal(senderFirstName('Ama Owusu Mensah'), 'Ama');
  assert.equal(senderFirstName('   '), null);
  assert.equal(senderFirstName(null), null);
});

test('a VIP guest sees what is left and who they can write to', async () => {
  used = 1;
  const result = await caller().eligibility({ partyId: 'party' });
  assert.equal(result.state, 'open');
  assert.equal(result.remaining, 2);
  assert.deepEqual(result.performers.map((performer: any) => performer.id), ['dj']);
});

test('a general ticket gets no performers, only the tiers that include requests', async () => {
  guestRow = { ...guestRow, ticketTierName: 'General' };
  const result = await caller().eligibility({ partyId: 'party' });
  assert.equal(result.state, 'no-request-ticket');
  assert.deepEqual(result.performers, []);
  assert.deepEqual(result.tiersWithRequests, [{ name: 'VIP', priceCents: 4000, requestNotes: 3 }]);
});

test('sending stores the first name only when the guest chooses to show it', async () => {
  await caller().send(send());
  await caller().send(send({ showName: false, idempotencyKey: '00000000-0000-4000-8000-000000000002' }));
  assert.equal(created[0].senderName, 'Ama');
  assert.equal(created[1].senderName, null);
  assert.equal(created[0].senderUserId, 'guest');
});

test('sending is refused without the perk, outside the party, past the allowance, or to someone off the lineup', async () => {
  guestRow = { ...guestRow, ticketTierName: 'General' };
  await assert.rejects(() => caller().send(send()), { code: 'FORBIDDEN' });
  guestRow = { ...guestRow, ticketTierName: 'VIP' };
  liveParty = { ...liveParty, startsAt: new Date(Date.now() + 3600_000) };
  await assert.rejects(() => caller().send(send()), { message: 'Requests open when the party starts.' });
  liveParty = { ...liveParty, startsAt: hourAgo, closedAt: new Date() };
  await assert.rejects(() => caller().send(send()), { message: 'Requests are closed for this party.' });
  liveParty = { ...liveParty, closedAt: null };
  used = 3;
  await assert.rejects(() => caller().send(send()), { message: "You've used all 3 requests your ticket includes." });
  used = 0;
  await assert.rejects(() => caller().send(send({ performerId: 'gone' })), { code: 'NOT_FOUND' });
  assert.equal(created.length, 0);
});

test('notes are one line of plain text up to 140 characters', async () => {
  await assert.rejects(() => caller().send(send({ body: 'line one\nline two' })), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().send(send({ body: 'x'.repeat(141) })), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().send(send({ body: '   ' })), { code: 'BAD_REQUEST' });
});

test('a retried send returns the original note instead of using another request', async () => {
  notes.findUnique = async () => noteRow();
  const result = await caller().send(send());
  assert.equal(result.id, 'note');
  assert.equal(created.length, 0);
  await assert.rejects(() => caller().send(send({ body: 'Different text' })), { code: 'CONFLICT' });
});

test('only the host or a confirmed performer can read the inbox or the stage screen', async () => {
  await assert.rejects(() => caller('guest').inbox({ partyId: 'party' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller('guest').screen({ partyId: 'party' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller(null).inbox({ partyId: 'party' }), { code: 'UNAUTHORIZED' });
  assert.equal((await caller('host').inbox({ partyId: 'party' })).role, 'host');
  assert.equal((await caller('performer').inbox({ partyId: 'party' })).role, 'performer');
  assert.equal((await caller('performer').screen({ partyId: 'party' })).notes.length, 1);
});

test('a performer decides only notes sent to them; the host decides any', async () => {
  await caller('performer').decide({ partyId: 'party', id: 'note', version: 0, decision: 'accept' });
  assert.deepEqual(updates[0].where.performerId, { in: ['dj'] });
  assert.deepEqual(updates[0].where.status, { in: ['sent'] });
  assert.equal(updates[0].data.status, 'accepted');
  assert.ok(updates[0].data.acceptedAt instanceof Date);
  await caller('host').decide({ partyId: 'party', id: 'note', version: 1, decision: 'dismiss' });
  assert.equal(updates[1].where.performerId, undefined);
  assert.deepEqual(updates[1].where.status, { in: ['sent', 'accepted', 'played'] });
  await assert.rejects(() => caller('guest').decide({ partyId: 'party', id: 'note', version: 0, decision: 'accept' }), { code: 'NOT_FOUND' });
});

test('a stale or out-of-order decision is a conflict', async () => {
  notes.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller('host').decide({ partyId: 'party', id: 'note', version: 0, decision: 'played' }), { code: 'CONFLICT' });
});
