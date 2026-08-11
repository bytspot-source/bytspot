import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory, resetLocalRateLimitForTests, router } from './trpc';
import { eventsRouter } from './eventsRouter';
import { db } from '../lib/db';
import type { Context } from './context';
import { readFileSync } from 'node:fs';

const appRouter = router({ events: eventsRouter });
const createCaller = createCallerFactory(appRouter);
const partyGuest = (db as any).partyGuest;
const consent = (db as any).partyMeetConsent;
const exchange = (db as any).partyMeetExchange;
const connection = (db as any).partyMeetConnection;
const block = (db as any).userBlock;
const report = (db as any).partyMeetReport;
const prisma = db as any;
const now = new Date();
const validConsent = { id: 'consent-a', expiresAt: new Date(now.getTime() + 60_000), withdrawnAt: null };
const checkedIn = { checkedInAt: new Date(now.getTime() - 1_000), party: { status: 'published' } };

function caller(userId = 'user-a') {
  const ctx: Context = { user: { userId, email: `${userId}@example.test` }, clientRateLimitKey: `people-met-${userId}` };
  return createCaller(ctx);
}

beforeEach(() => {
  resetLocalRateLimitForTests();
  partyGuest.findUnique = async () => checkedIn;
  consent.findFirst = async () => validConsent;
  consent.findUnique = async () => null;
  consent.upsert = async ({ create }: any) => ({ expiresAt: create.expiresAt, withdrawnAt: null });
  consent.updateMany = async () => ({ count: 1 });
  exchange.findFirst = async () => null;
  exchange.create = async ({ data }: any) => ({ id: 'exchange-1', ...data });
  exchange.updateMany = async () => ({ count: 1 });
  connection.findUnique = async () => null;
  connection.findFirst = async () => null;
  connection.findMany = async () => [];
  connection.create = async ({ data }: any) => ({ id: 'connection-1', ...data });
  connection.upsert = async ({ create }: any) => ({ id: 'connection-1', ...create, party: { title: 'Quiet Room' }, userLow: { id: 'user-a', name: 'A', profileImage: null }, userHigh: { id: 'user-b', name: 'B', profileImage: null } });
  connection.updateMany = async () => ({ count: 1 });
  block.findFirst = async () => null;
  block.upsert = async () => ({ id: 'block-1' });
  report.create = async () => ({ id: 'report-1' });
  prisma.$transaction = async (operation: any) => operation({ partyGuest, partyMeetConsent: consent, partyMeetExchange: exchange, partyMeetConnection: connection, userBlock: block, partyMeetReport: report, $executeRaw: async () => 1 });
});

test('People You Met forward repair migration asserts the complete privacy constraint contract', () => {
  const migration = readFileSync(new URL('../../prisma/migrations/20260816_repair_party_people_met_constraints/migration.sql', import.meta.url), 'utf8');
  assert.match(migration, /People You Met repair requires table/);
  assert.match(migration, /information_schema\.columns/);
  assert.match(migration, /pg_attrdef/);
  assert.match(migration, /PartyMeetReportReason enum contract/);
  assert.match(migration, /conrelid = 'public\.party_meet_exchanges'::regclass/);
  assert.match(migration, /pg_get_constraintdef/);
  for (const constraint of [
    'party_meet_exchanges_code_hash_key',
    'party_meet_connections_canonical_pair_check',
    'party_meet_connections_party_id_user_low_id_user_high_id_key',
    'user_blocks_not_self_check',
    'user_blocks_blocker_user_id_blocked_user_id_key',
  ]) assert.match(migration, new RegExp(`ADD CONSTRAINT "${constraint}"`));
  for (const lifecycleColumn of ['checked_in_at', 'revoked_at', 'deleted_at', 'closed_at']) {
    assert.match(migration, new RegExp(`'${lifecycleColumn}'`));
  }
});

test('People You Met opt-in requires a confirmed Party check-in and expiry is fixed to that check-in', async () => {
  partyGuest.findUnique = async () => ({ checkedInAt: null, party: { status: 'published' } });
  await assert.rejects(() => caller().events.peopleMet.optIn({ partyId: 'party-1' }), { code: 'FORBIDDEN' });

  const checkIn = new Date(Date.now() - 60_000);
  partyGuest.findUnique = async () => ({ checkedInAt: checkIn, party: { status: 'published' } });
  let upsert: any;
  consent.upsert = async (input: any) => { upsert = input; return { expiresAt: input.create.expiresAt, withdrawnAt: null }; };
  const result = await caller().events.peopleMet.optIn({ partyId: 'party-1' });
  assert.equal(result.expiresAt.getTime(), checkIn.getTime() + 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(upsert.update, {});
});

test('issueExchangeCode stores only a digest and serializes replacement under the issuer lock', async () => {
  const updates: any[] = [];
  exchange.updateMany = async (input: any) => { updates.push(input); return { count: 1 }; };
  let created: any;
  exchange.create = async (input: any) => { created = input; return { id: 'exchange-1' }; };
  let transactionOptions: any;
  let lockCalls = 0;
  prisma.$transaction = async (operation: any, options: any) => {
    transactionOptions = options;
    return operation({ partyGuest, partyMeetConsent: consent, partyMeetExchange: exchange, partyMeetConnection: connection, userBlock: block, partyMeetReport: report, $executeRaw: async () => { lockCalls += 1; return 1; } });
  };
  const result = await caller().events.peopleMet.issueExchangeCode({ partyId: 'party-1' });
  assert.match(result.exchangeCode, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.data.codeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(created.data.codeHash, result.exchangeCode);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.issuerUserId, 'user-a');
  assert.ok(updates[0].data.revokedAt instanceof Date);
  assert.equal(lockCalls, 1);
  assert.equal(transactionOptions.isolationLevel, 'Serializable');
});

test('redemption requires mutual active same-party consent and returns opaque failures without identity', async () => {
  exchange.findFirst = async () => ({ id: 'exchange-1', issuerUserId: 'user-b', consentId: 'consent-b', consent: { userId: 'user-b', expiresAt: new Date(Date.now() + 60_000) } });
  partyGuest.findUnique = async () => ({ checkedInAt: new Date(), party: { status: 'published' } });
  consent.findFirst = async () => ({ id: 'consent-a', expiresAt: new Date(Date.now() + 60_000) });
  block.findFirst = async () => null;
  exchange.updateMany = async () => ({ count: 1 });
  connection.findUnique = async () => null;
  let created: any;
  connection.upsert = async (input: any) => {
    created = input;
    return { id: 'connection-1', ...input.create, party: { title: 'Quiet Room' }, userLow: { id: 'user-a', name: 'A', profileImage: null }, userHigh: { id: 'user-b', name: 'B', profileImage: 'https://img.example/b' } };
  };
  const result = await caller('user-a').events.peopleMet.redeemExchangeCode({ partyId: 'party-1', exchangeCode: 'B'.repeat(43) });
  assert.equal(result.connection.person.id, 'user-b');
  assert.equal(result.connection.party.title, 'Quiet Room');
  assert.deepEqual(Object.keys(result.connection.person).sort(), ['id', 'name', 'profileImage']);
  assert.deepEqual(created.create, { partyId: 'party-1', userLowId: 'user-a', userHighId: 'user-b', expiresAt: created.create.expiresAt });

  exchange.findFirst = async () => null;
  await assert.rejects(
    () => caller('user-a').events.peopleMet.redeemExchangeCode({ partyId: 'party-1', exchangeCode: 'C'.repeat(43) }),
    { code: 'NOT_FOUND', message: 'Unable to complete this exchange.' },
  );
});

test('redemption denies self, block, and replay cases with the same opaque response', async () => {
  const base = { id: 'exchange-1', issuerUserId: 'user-b', consentId: 'consent-b', consent: { userId: 'user-b', expiresAt: new Date(Date.now() + 60_000) } };
  partyGuest.findUnique = async () => ({ checkedInAt: new Date(), party: { status: 'published' } });
  consent.findFirst = async () => ({ id: 'consent-a', expiresAt: new Date(Date.now() + 60_000) });
  exchange.updateMany = async () => ({ count: 0 });
  exchange.findFirst = async () => ({ ...base, issuerUserId: 'user-a', consent: { ...base.consent, userId: 'user-a' } });
  await assert.rejects(() => caller('user-a').events.peopleMet.redeemExchangeCode({ partyId: 'party-1', exchangeCode: 'D'.repeat(43) }), { code: 'NOT_FOUND', message: 'Unable to complete this exchange.' });

  exchange.findFirst = async () => base;
  block.findFirst = async () => ({ id: 'blocked' });
  await assert.rejects(() => caller('user-a').events.peopleMet.redeemExchangeCode({ partyId: 'party-1', exchangeCode: 'D'.repeat(43) }), { code: 'NOT_FOUND', message: 'Unable to complete this exchange.' });

  block.findFirst = async () => null;
  await assert.rejects(() => caller('user-a').events.peopleMet.redeemExchangeCode({ partyId: 'party-1', exchangeCode: 'D'.repeat(43) }), { code: 'NOT_FOUND', message: 'Unable to complete this exchange.' });
});

test('status cannot enumerate attendees or opt-ins and connections select no email', async () => {
  let selected: any;
  connection.findMany = async (input: any) => { selected = input; return []; };
  const result = await caller().events.peopleMet.status({ partyId: 'party-1' });
  assert.deepEqual(Object.keys(result).sort(), ['connections', 'consent']);
  assert.equal('attendees' in result, false);
  assert.equal('count' in result, false);
  assert.deepEqual(selected.select.userLow.select, { id: true, name: true, profileImage: true });
  assert.equal('email' in selected.select.userLow.select, false);
});

test('redemption rejects an unpublished Party with the same opaque error', async () => {
  exchange.findFirst = async () => ({ id: 'exchange-1', issuerUserId: 'user-b', consentId: 'consent-b', consent: { userId: 'user-b', expiresAt: new Date(Date.now() + 60_000) } });
  partyGuest.findUnique = async () => ({ checkedInAt: new Date(), party: { status: 'draft' } });
  await assert.rejects(() => caller('user-a').events.peopleMet.redeemExchangeCode({ partyId: 'party-1', exchangeCode: 'E'.repeat(43) }), { code: 'NOT_FOUND', message: 'Unable to complete this exchange.' });
});

test('global block closes every pair connection and report-with-block is atomic', async () => {
  connection.findFirst = async () => ({ id: 'connection-1', partyId: 'party-1', userLowId: 'user-a', userHighId: 'user-b' });
  const updates: any[] = [];
  connection.updateMany = async (input: any) => { updates.push(input); return { count: 2 }; };
  await caller('user-a').events.peopleMet.blockConnection({ connectionId: 'connection-1' });
  assert.deepEqual(updates[0].where, { userLowId: 'user-a', userHighId: 'user-b', deletedAt: null, closedAt: null });
  let reportCreated = false;
  report.create = async () => { reportCreated = true; return { id: 'report-1' }; };
  await caller('user-a').events.peopleMet.reportConnection({ connectionId: 'connection-1', reason: 'safety', block: true });
  assert.equal(reportCreated, true);
});

test('deletion closes a connection for both sides and reports remain private', async () => {
  let deletion: any;
  connection.updateMany = async (input: any) => { deletion = input; return { count: 1 }; };
  assert.deepEqual(await caller('user-a').events.peopleMet.deleteConnection({ connectionId: 'connection-1' }), { status: 'deleted' });
  assert.equal(deletion.where.OR[0].userLowId, 'user-a');
  assert.ok(deletion.data.deletedAt instanceof Date);
  assert.ok(deletion.data.closedAt instanceof Date);

  connection.findFirst = async () => ({ id: 'connection-1', partyId: 'party-1', userLowId: 'user-a', userHighId: 'user-b' });
  const reported = await caller('user-a').events.peopleMet.reportConnection({ connectionId: 'connection-1', reason: 'safety', details: 'Please review.' });
  assert.deepEqual(reported, { status: 'received' });
});
