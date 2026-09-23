import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { purgeAbandonedPartyDrafts } from './abandonedDrafts';
import { ABANDONED_DRAFT_TTL_MS } from '../trpc/partyRouter';

const party = db.party as any;
const now = new Date('2026-09-23T12:00:00Z');

beforeEach(() => {
  party.findMany = async () => [];
  party.deleteMany = async () => ({ count: 0 });
});

test('The sweeper only ever asks for drafts nobody has touched inside the TTL', async () => {
  let query: any;
  party.findMany = async (input: any) => { query = input; return []; };

  assert.deepEqual(await purgeAbandonedPartyDrafts(now), { purged: 0 });

  // A published party owns guest lists and payment records, which is exactly
  // why events.drafts.delete refuses to remove one once money is in motion.
  // An unattended job must not do what a host is forbidden to do by hand.
  assert.equal(query.where.status, 'draft');
  assert.deepEqual(query.where.updatedAt, { lte: new Date(now.getTime() - ABANDONED_DRAFT_TTL_MS) });
  assert.deepEqual(query.where.guests, { none: {} });
  assert.deepEqual(query.where.checkouts, { none: {} });
});

test('A draft touched inside the TTL is never swept', async () => {
  // Nothing is due, so nothing is deleted — and no delete is even attempted.
  let deleteCalls = 0;
  party.deleteMany = async () => { deleteCalls += 1; return { count: 0 }; };

  assert.deepEqual(await purgeAbandonedPartyDrafts(now), { purged: 0 });
  assert.equal(deleteCalls, 0);
});

test('The delete re-asserts the whole predicate, so a returning host keeps the draft', async () => {
  party.findMany = async () => [{ id: 'party-1' }, { id: 'party-2' }];
  let where: any;
  party.deleteMany = async (input: any) => { where = input.where; return { count: 1 } };

  // A host can reopen a draft between the read and the write. The count comes
  // from the delete, not the read, so the survivor is not reported as purged.
  assert.deepEqual(await purgeAbandonedPartyDrafts(now), { purged: 1 });
  assert.deepEqual(where.id, { in: ['party-1', 'party-2'] });
  assert.equal(where.status, 'draft');
  assert.deepEqual(where.updatedAt, { lte: new Date(now.getTime() - ABANDONED_DRAFT_TTL_MS) });
  assert.deepEqual(where.guests, { none: {} });
  assert.deepEqual(where.checkouts, { none: {} });
});

test('A draft holding guests or checkouts is left for a human rather than swept', async () => {
  // Defence in depth: guests arrive through a share link and a draft has never
  // been issued one. If that invariant ever breaks, the row survives.
  party.findMany = async (input: any) => {
    assert.deepEqual(input.where.guests, { none: {} });
    assert.deepEqual(input.where.checkouts, { none: {} });
    return [];
  };
  assert.deepEqual(await purgeAbandonedPartyDrafts(now), { purged: 0 });
});
