import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import {
  InviteRefused, MAX_OPEN_INVITES_PER_PARTY,
  cancelHostInvite, createHostInvite, listSellerInvites, respondToInvite, searchInvitableSellers,
} from './partySellerInvites';

const party = db.party as any;
const seller = db.vendorSeller as any;
const invites = db.partySellerInvite as any;
const sessions = db.partySession as any;
const checkouts = db.partyCheckout as any;

const NOW = new Date('2026-10-26T18:00:00Z');
const hostParty = (overrides: Record<string, unknown> = {}) => ({
  id: 'party-1', title: 'Rooftop', startsAt: new Date('2026-10-31T02:00:00Z'), endsAt: null, closedAt: null,
  venueName: 'The Roof', host: { name: 'Dee' }, ...overrides,
});
const invite = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-1', partyId: 'party-1', sellerId: 'seller-1', state: 'PENDING', note: null,
  createdAt: NOW, respondedAt: null, seller: { legalName: 'Bottle Co' }, ...overrides,
});
const refused = (reason: string) => (err: unknown) => err instanceof InviteRefused && err.reason === reason;

let writes: any[];
beforeEach(() => {
  writes = [];
  party.findFirst = async () => hostParty();
  seller.findFirst = async () => ({ id: 'seller-1', legalName: 'Bottle Co', contactEmail: null, seats: [] });
  invites.findUnique = async () => null;
  invites.count = async () => 0;
  invites.create = async (args: any) => { writes.push(['create', args.data]); return invite(); };
  invites.update = async (args: any) => { writes.push(['update', args.data]); return invite(args.data); };
  invites.updateMany = async (args: any) => { writes.push(['updateMany', args]); return { count: 1 }; };
  sessions.groupBy = async () => [];
  sessions.count = async () => 0;
  (db.iOSPushDevice as any).findMany = async () => [];
});

test('A host can only ask on their own Party, and only before it ends', async () => {
  let where: any;
  party.findFirst = async (args: any) => { where = args.where; return null; };
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('NOT_FOUND'));
  assert.equal(where.hostUserId, 'host-1');
  assert.deepEqual(where.status, { not: 'cancelled' });

  party.findFirst = async () => hostParty({ closedAt: NOW });
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('CONFLICT'));
  party.findFirst = async () => hostParty({ startsAt: new Date('2026-10-26T10:00:00Z') });
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('CONFLICT'));
  assert.equal(writes.length, 0);
});

test('Only a live business is asked, and a business the host is on the team of sells through the seat instead', async () => {
  let where: any;
  seller.findFirst = async (args: any) => { where = args.where; return null; };
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('NOT_FOUND'));
  assert.equal(where.state, 'ACTIVE');

  seller.findFirst = async () => ({ id: 'seller-1', legalName: 'Bottle Co', contactEmail: null, seats: [{ id: 'seat-1' }] });
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('BAD_REQUEST'));
  assert.equal(writes.length, 0);
});

test('Asking twice returns the open ask; a decline stands; a cancelled ask reopens', async () => {
  invites.findUnique = async () => invite({ state: 'PENDING' });
  assert.equal((await createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW)).state, 'PENDING');
  assert.equal(writes.length, 0);

  invites.findUnique = async () => invite({ state: 'DECLINED' });
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('CONFLICT'));

  invites.findUnique = async () => invite({ state: 'CANCELLED', respondedAt: NOW });
  const reopened = await createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1', note: '  Two tables?  ' }, NOW);
  assert.equal(reopened.state, 'PENDING');
  assert.deepEqual(writes, [['update', { state: 'PENDING', note: 'Two tables?', respondedAt: null, respondedByUserId: null }]]);
});

test('A Party has a ceiling on open asks', async () => {
  invites.count = async () => MAX_OPEN_INVITES_PER_PARTY;
  await assert.rejects(() => createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW), refused('CONFLICT'));
  invites.count = async () => MAX_OPEN_INVITES_PER_PARTY - 1;
  await createHostInvite('host-1', { partyId: 'party-1', sellerId: 'seller-1' }, NOW);
  assert.deepEqual(writes, [['create', { partyId: 'party-1', sellerId: 'seller-1', note: null }]]);
});

test('A host withdraws an unanswered ask, but cannot remove a business whose tables are still on sale', async () => {
  invites.findFirst = async () => invite({ state: 'PENDING' });
  assert.equal((await cancelHostInvite('host-1', { partyId: 'party-1', inviteId: 'inv-1' })).state, 'CANCELLED');

  invites.findFirst = async () => invite({ state: 'ACCEPTED' });
  sessions.groupBy = async () => [{ sellerId: 'seller-1', _count: { _all: 2 } }];
  await assert.rejects(() => cancelHostInvite('host-1', { partyId: 'party-1', inviteId: 'inv-1' }), refused('CONFLICT'));

  sessions.groupBy = async () => [];
  assert.equal((await cancelHostInvite('host-1', { partyId: 'party-1', inviteId: 'inv-1' })).state, 'REMOVED');
  // Each move is conditional on the state it read, so a concurrent answer is not overwritten.
  assert.deepEqual(writes.map(([, args]) => args.where), [{ id: 'inv-1', state: 'PENDING' }, { id: 'inv-1', state: 'ACCEPTED' }]);
});

test('A business answers only its own asks, and accepting is refused once the host withdrew it', async () => {
  let where: any;
  invites.findFirst = async (args: any) => { where = args.where; return null; };
  await assert.rejects(() => respondToInvite('seller-1', 'user-9', 'inv-1', 'accept', NOW), refused('NOT_FOUND'));
  assert.deepEqual(where, { id: 'inv-1', sellerId: 'seller-1' });

  const withParty = (state: string) => invite({ state, party: { ...hostParty(), hostUserId: 'host-1', status: 'published' } });
  invites.findFirst = async () => withParty('CANCELLED');
  await assert.rejects(() => respondToInvite('seller-1', 'user-9', 'inv-1', 'accept', NOW), refused('CONFLICT'));

  invites.findFirst = async () => withParty('PENDING');
  assert.deepEqual(await respondToInvite('seller-1', 'user-9', 'inv-1', 'accept', NOW), { id: 'inv-1', state: 'ACCEPTED' });
  assert.deepEqual(writes.at(-1)[1], { where: { id: 'inv-1', state: 'PENDING' }, data: { state: 'ACCEPTED', respondedAt: NOW, respondedByUserId: 'user-9' } });

  invites.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => respondToInvite('seller-1', 'user-9', 'inv-1', 'accept', NOW), refused('CONFLICT'));
});

test('A business cannot leave a Party while its sessions are on sale', async () => {
  invites.findFirst = async () => invite({ state: 'ACCEPTED', party: { ...hostParty(), hostUserId: 'host-1', status: 'published' } });
  sessions.count = async () => 1;
  await assert.rejects(() => respondToInvite('seller-1', 'user-9', 'inv-1', 'decline', NOW), refused('CONFLICT'));
  sessions.count = async () => 0;
  assert.equal((await respondToInvite('seller-1', 'user-9', 'inv-1', 'decline', NOW)).state, 'DECLINED');
});

test('Search finds live businesses only, leaves out the host\'s own teams, and needs two characters', async () => {
  let where: any;
  let searches = 0;
  seller.findMany = async (args: any) => { searches += 1; where = args.where; return [{ id: 'seller-2', legalName: 'Bottle Co', locations: [{ label: 'Midtown' }] }]; };
  invites.findMany = async () => [{ sellerId: 'seller-2', state: 'DECLINED' }];

  assert.deepEqual(await searchInvitableSellers('host-1', 'party-1', ' b '), { sellers: [] });
  assert.equal(searches, 0);

  const found = await searchInvitableSellers('host-1', 'party-1', 'bottle');
  assert.equal(where.state, 'ACTIVE');
  assert.deepEqual(where.seats, { none: { userId: 'host-1', state: 'ACTIVE' } });
  assert.deepEqual(found, { sellers: [{ id: 'seller-2', name: 'Bottle Co', place: 'Midtown', invite: 'DECLINED' }] });
});

test('A business sees its open asks with what completed table sales owe it, and nothing of another business', async () => {
  const asked: any[] = [];
  invites.findMany = async (args: any) => {
    asked.push(args.where);
    return [
      invite({ state: 'ACCEPTED', party: hostParty() }),
      invite({ id: 'inv-2', partyId: 'party-2', state: 'PENDING', party: hostParty({ id: 'party-2', startsAt: new Date('2026-10-20T02:00:00Z'), host: { name: null } }) }),
    ];
  };
  sessions.groupBy = async (args: any) => { asked.push(args.where); return [{ partyId: 'party-1', _count: { _all: 3 } }]; };
  checkouts.groupBy = async (args: any) => { asked.push(args.where); return [{ partyId: 'party-1', _sum: { sellerNetCents: 36_000 } }]; };

  const { invites: rows } = await listSellerInvites('seller-1', NOW);

  assert.deepEqual(asked[0], { sellerId: 'seller-1', state: { in: ['PENDING', 'ACCEPTED'] }, party: { status: { not: 'cancelled' } } });
  assert.ok(asked.slice(1).every((where) => where.sellerId === 'seller-1'));
  assert.equal(asked[2].status, 'completed');
  assert.deepEqual(rows.map((row) => [row.id, row.liveSessions, row.owedCents, row.party.ended, row.party.hostName]), [
    ['inv-1', 3, 36_000, false, 'Dee'],
    ['inv-2', 0, 0, true, 'A Bytspot host'],
  ]);
});
