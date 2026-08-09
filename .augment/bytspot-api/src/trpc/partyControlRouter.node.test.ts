import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const hostContext: Context = { user: { userId: 'host-1', email: 'host@example.com' } };
const party = { id: 'party-1', hostUserId: 'host-1', status: 'published', title: 'A Party', capacity: 3, admissionPausedAt: null };
const prisma = db as any;
const partyStore = db.party as any;
const guestStore = db.partyGuest as any;
const userStore = db.user as any;

function caller() { return createCaller(hostContext); }
function transaction(overrides: Record<string, unknown> = {}) {
  return { party: partyStore, partyGuest: guestStore, user: userStore, $queryRaw: async () => [], ...overrides };
}

beforeEach(() => {
  partyStore.findFirst = async () => party;
  partyStore.update = async () => party;
  guestStore.groupBy = async () => [{ status: 'confirmed', _count: { _all: 1 } }, { status: 'pending', _count: { _all: 1 } }, { status: 'pending-payment', _count: { _all: 1 } }];
  guestStore.findMany = async () => [];
  guestStore.findFirst = async () => null;
  guestStore.findUnique = async () => null;
  guestStore.update = async () => ({ id: 'guest-1' });
  guestStore.create = async (input: any) => ({ id: 'guest-1', ...input.data });
  userStore.findUnique = async () => ({ email: 'guest@example.com', membershipTier: 'green' });
  prisma.$transaction = async (callback: any) => typeof callback === 'function' ? callback(transaction()) : Promise.all(callback);
});

test('host summary separates confirmed capacity from pending work', async () => {
  const summary = await caller().events.control.summary({ partyId: 'party-1' });
  assert.deepEqual(summary, { partyId: 'party-1', title: 'A Party', admissionPaused: false, capacity: 3, confirmed: 1, spacesRemaining: 2, pending: 2, checkedIn: 0 });
});

test('a host approval issues a hashed personal attendee credential', async () => {
  guestStore.findFirst = async () => ({ id: 'guest-1', partyId: 'party-1', userId: 'guest-1', status: 'pending' });
  guestStore.groupBy = async () => [];
  let updateData: any;
  guestStore.update = async ({ data }: any) => { updateData = data; return { id: 'guest-1' }; };
  const result = await caller().events.control.decide({ partyId: 'party-1', guestId: 'guest-1', decision: 'approved' });
  assert.equal(result.status, 'approved');
  assert.match(result.attendeePassUrl ?? '', /^https:\/\/bytspot\.app\/party-pass\//);
  assert.equal(updateData.attendeePassHash?.length, 64);
  assert.ok(updateData.attendeePassIssuedAt instanceof Date);
});

test('a previously checked-in attendee credential cannot be replayed', async () => {
  guestStore.findFirst = async () => ({ id: 'guest-1', status: 'checked-in', checkedInAt: new Date() });
  await assert.rejects(
    () => caller().events.control.checkIn({ partyId: 'party-1', attendeePassSecret: 'a-secure-personal-pass-secret' }),
    { code: 'CONFLICT' },
  );
});