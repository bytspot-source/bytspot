import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import type { Context } from './context';
import { capabilityForAccessMode, capabilityForSupply, isProposedPlanExpired, itemIsBooked, openNeeds, planDisplayState, planReadiness } from './planRouter';
import { controlFromCapability } from '../services/bookableProjection';

const idempotencyKey = '00000000-0000-4000-8000-000000000010';
const createCaller = createCallerFactory(appRouter);
const plan = db.plan as any;
const planParticipant = db.planParticipant as any;
const planItem = db.planItem as any;
const party = db.party as any;
const user = db.user as any;
const coffeeReservation = db.coffeeReservation as any;
const bookable = db.bookable as any;
const partyGuest = db.partyGuest as any;

const creatorContext: Context = { user: { userId: 'creator-id', email: 'creator@bytspot.com' }, clientRateLimitKey: 'test-plan-creator' };
const guestContext: Context = { user: { userId: 'guest-id', email: 'guest@bytspot.com' }, clientRateLimitKey: 'test-plan-guest' };
const strangerContext: Context = { user: { userId: 'stranger-id', email: 'stranger@bytspot.com' }, clientRateLimitKey: 'test-plan-stranger' };

const caller = () => createCaller(creatorContext);
const guest = () => createCaller(guestContext);
const stranger = () => createCaller(strangerContext);

const creatorSeat = { userId: 'creator-id', role: 'creator', status: 'accepted' };
const guestSeat = { userId: 'guest-id', role: 'guest', status: 'invited' };

function planFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    creatorUserId: 'creator-id',
    title: 'Friday Night',
    intent: 'Go out',
    startsAt: null,
    endsAt: null,
    areaLabel: 'Midtown',
    partySize: 4,
    joinToken: 'tok-secret',
    needs: [] as string[],
    lifecycle: 'proposed',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    participants: [creatorSeat, guestSeat],
    items: [] as any[],
    ...overrides,
  };
}

beforeEach(() => {
  // Every serializable write re-reads on the transaction client, so the mock
  // has to hand the caller back the same tables it would see outside.
  (db as any).$transaction = async (fn: (tx: any) => Promise<unknown>) => fn(db);
  plan.findUnique = async () => null;
  plan.findMany = async () => [];
  plan.create = async () => ({ id: 'plan-1' });
  plan.update = async ({ data }: any) => ({ id: 'plan-1', lifecycle: data.lifecycle ?? 'proposed' });
  plan.updateMany = async () => ({ count: 1 });
  planParticipant.create = async ({ data }: any) => ({ status: data.status });
  planParticipant.update = async ({ data }: any) => ({ status: data.status });
  planParticipant.updateMany = async () => ({ count: 1 });
  planParticipant.findUnique = async () => null;
  planItem.create = async ({ data }: any) => ({ id: 'item-1', capability: data.capability, status: 'available' });
  bookable.create = async ({ data }: any) => data;
  planItem.update = async () => ({ id: 'item-1', status: 'cancelled' });
  planItem.updateMany = async () => ({ count: 1 });
  party.findFirst = async () => null;
  user.findUnique = async () => ({ id: 'guest-id' });
  coffeeReservation.findFirst = async () => null;
  // No party guest holds granted access unless a test says so.
  partyGuest.findMany = async () => [];
  partyGuest.groupBy = async () => [];
  party.findMany = async () => [];
});

// ─── Derived state ────────────────────────────────────────────────────────────

test('Booked, active, and completed are derived, so the Plan cannot outrun its bookings', () => {
  const now = new Date('2026-09-03T20:00:00Z');
  const base = { lifecycle: 'confirmed', startsAt: null, endsAt: null, expiresAt: null, needs: [] };

  // Confirmed with nothing attached is not Booked — an empty Plan books nothing.
  assert.equal(planDisplayState(base, [], now), 'confirmed');
  // One unbooked item is enough to keep the whole Plan out of Booked.
  assert.equal(planDisplayState(base, [{ needKind: 'dining', status: 'booked' }, { needKind: 'parking', status: 'available' }], now), 'confirmed');
  assert.equal(planDisplayState(base, [{ needKind: 'dining', status: 'booked' }], now), 'booked');
  // A cancelled item is not counted against the Plan.
  assert.equal(planDisplayState(base, [{ needKind: 'dining', status: 'booked' }, { needKind: 'parking', status: 'cancelled' }], now), 'booked');
  // A details item is a reference Bytspot never booked, so even marked booked
  // it cannot carry the Plan into Booked.
  assert.equal(planDisplayState(base, [{ needKind: 'dining', status: 'booked', capability: 'details' }], now), 'confirmed');
  // Every item cancelled is not Booked either.
  assert.equal(planDisplayState(base, [{ needKind: 'dining', status: 'cancelled' }], now), 'confirmed');

  // The clock outranks the bookings.
  const started = { ...base, startsAt: new Date('2026-09-03T19:00:00Z'), endsAt: new Date('2026-09-03T23:00:00Z') };
  assert.equal(planDisplayState(started, [{ needKind: 'dining', status: 'booked' }], now), 'active');
  assert.equal(planDisplayState({ ...started, endsAt: new Date('2026-09-03T19:30:00Z') }, [], now), 'completed');
});

test('A proposed Plan expires on read, and confirming clears the clock', () => {
  const now = new Date('2026-09-03T20:00:00Z');
  const stale = { lifecycle: 'proposed', startsAt: null, endsAt: null, expiresAt: new Date('2026-09-03T19:00:00Z'), needs: [] };
  assert.equal(isProposedPlanExpired(stale, now), true);
  assert.equal(planDisplayState(stale, [], now), 'expired');

  // Only proposed plans expire; a confirmed Plan completes instead.
  assert.equal(isProposedPlanExpired({ ...stale, lifecycle: 'confirmed' }, now), false);
  assert.equal(planDisplayState({ ...stale, lifecycle: 'cancelled' }, [], now), 'cancelled');

  // A lifecycle the CHECK constraint should make unstorable is clamped rather
  // than echoed, so a bad row cannot render as a derived state.
  assert.equal(planDisplayState({ ...stale, lifecycle: 'booked', expiresAt: null }, [], now), 'proposed');
});

test('Capability is read off the room, so it states who actually controls fulfilment', () => {
  assert.equal(capabilityForAccessMode('free-rsvp'), 'book');
  assert.equal(capabilityForAccessMode('paid-ticket'), 'book');
  assert.equal(capabilityForAccessMode('private-approval'), 'request');
  // Anything Bytspot does not settle is a reference the user resolves.
  assert.equal(capabilityForAccessMode('walk-up'), 'details');
});

test('capabilityForSupply derives from the supply kind and never trusts the caller', () => {
  assert.equal(capabilityForSupply({ party: { accessMode: 'free-rsvp' } }), 'book');
  assert.equal(capabilityForSupply({ party: { accessMode: 'private-approval' } }), 'request');
  // A coffee reservation is a hold ask, not a payment. Always request.
  assert.equal(capabilityForSupply({ reservation: { id: 'r-1' } }), 'request');
  // Nothing behind it is a reference, and that is the fail-closed default.
  assert.equal(capabilityForSupply({}), 'details');
});

test('Readiness travels beside the state, so Confirmed never stands alone', () => {
  const readiness = planReadiness([
    { status: 'accepted' }, { status: 'accepted' }, { status: 'invited' }, { status: 'declined' }, { status: 'maybe' }, { status: 'removed' },
  ]);
  assert.deepEqual(readiness, { going: 2, maybe: 1, pending: 1, declined: 1, total: 5 });
});

test('A need with a live item attached is closed; a cancelled one reopens it', () => {
  const shape = { lifecycle: 'confirmed', startsAt: null, endsAt: null, expiresAt: null, needs: ['dining', 'parking', 'nightlife'] };
  assert.deepEqual(openNeeds(shape, [{ needKind: 'dining', status: 'booked' }]), ['parking', 'nightlife']);
  assert.deepEqual(openNeeds(shape, [{ needKind: 'dining', status: 'cancelled' }]), ['dining', 'parking', 'nightlife']);
});

// ─── Authorization ────────────────────────────────────────────────────────────

test('A Plan is indistinguishable from a deleted one to anyone not on it', async () => {
  plan.findUnique = async () => planFixture();
  await assert.rejects(() => stranger().plans.get({ planId: 'plan-1' }), { code: 'NOT_FOUND' });
  // Creator-only surfaces refuse a participant the same way — never FORBIDDEN,
  // which would confirm the Plan exists.
  await assert.rejects(() => guest().plans.confirm({ planId: 'plan-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => guest().plans.invite({ planId: 'plan-1', userId: 'x' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => guest().plans.cancel({ planId: 'plan-1' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => guest().plans.setNeeds({ planId: 'plan-1', needs: [] }), { code: 'NOT_FOUND' });
});

test('Removal ends access; declining does not', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, { ...guestSeat, status: 'removed' }] });
  await assert.rejects(() => guest().plans.get({ planId: 'plan-1' }), { code: 'NOT_FOUND' });

  // Someone who said no keeps their seat and may change their mind.
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, { ...guestSeat, status: 'declined' }] });
  assert.equal((await guest().plans.get({ planId: 'plan-1' })).id, 'plan-1');
  assert.deepEqual(await guest().plans.respond({ planId: 'plan-1', response: 'accepted' }), { status: 'accepted' });
});

test('A participant answers only for themselves, and the creator owns the Plan alone', async () => {
  plan.findUnique = async () => planFixture();
  // The creator confirms without waiting for anyone.
  assert.deepEqual(await caller().plans.confirm({ planId: 'plan-1' }), { id: 'plan-1', lifecycle: 'confirmed' });
  // The confirm is conditioned on the row still being proposed.
  let confirmWhere: any = null;
  plan.updateMany = async (args: any) => { confirmWhere = args.where; return { count: 1 }; };
  await caller().plans.confirm({ planId: 'plan-1' });
  assert.deepEqual(confirmWhere, { id: 'plan-1', lifecycle: 'proposed' });
  // There is no procedure to answer on someone else's behalf: respond takes no
  // userId, and remove is the creator's, not a way to decline for a guest.
  await assert.rejects(() => caller().plans.remove({ planId: 'plan-1', userId: 'creator-id' }), { code: 'BAD_REQUEST' });
  planParticipant.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().plans.remove({ planId: 'plan-1', userId: 'nobody' }), { code: 'NOT_FOUND' });
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

test('Create is idempotent and seats the creator as already going', async () => {
  let seeded: any = null;
  plan.create = async ({ data }: any) => { seeded = data; return { id: 'plan-1' }; };
  await caller().plans.create({ idempotencyKey, title: 'Friday Night', intent: 'Go out', needs: ['dining', 'dining', 'parking'] });
  assert.deepEqual(seeded.participants.create, { userId: 'creator-id', role: 'creator', status: 'accepted', respondedAt: seeded.participants.create.respondedAt });
  // Needs are de-duplicated, and an unscheduled Plan still gets a deadline.
  assert.deepEqual(seeded.needs, ['dining', 'parking']);
  assert.ok(seeded.expiresAt instanceof Date);
  // A url-safe bearer join token is minted at creation, not left to chance.
  assert.match(seeded.joinToken, /^[A-Za-z0-9_-]{32}$/);

  plan.findUnique = async () => ({ id: 'plan-existing' });
  assert.deepEqual(await caller().plans.create({ idempotencyKey, title: 'Friday Night', intent: 'Go out' }), { id: 'plan-existing' });
});

test('A Plan that starts is given its own start as the deadline', async () => {
  const startsAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  let seeded: any = null;
  plan.create = async ({ data }: any) => { seeded = data; return { id: 'plan-1' }; };
  await caller().plans.create({ idempotencyKey, title: 'Friday', intent: 'Dinner', startsAt });
  assert.equal(seeded.expiresAt.getTime(), startsAt.getTime());

  await assert.rejects(
    () => caller().plans.create({ idempotencyKey, title: 'Friday', intent: 'Dinner', startsAt, endsAt: new Date(startsAt.getTime() - 1000) }),
    { code: 'BAD_REQUEST' },
  );
});

test('An expired or cancelled Plan refuses every reshaping call', async () => {
  for (const dead of [{ expiresAt: new Date(Date.now() - 1000) }, { lifecycle: 'cancelled' }]) {
    plan.findUnique = async () => planFixture({ ...dead, items: [{ id: 'item-1', needKind: 'dining', title: 'Dinner', status: 'available' }] });
    await assert.rejects(() => caller().plans.confirm({ planId: 'plan-1' }), { code: 'CONFLICT' });
    await assert.rejects(() => caller().plans.invite({ planId: 'plan-1', userId: 'guest-id' }), { code: 'CONFLICT' });
    await assert.rejects(() => caller().plans.setNeeds({ planId: 'plan-1', needs: ['dining'] }), { code: 'CONFLICT' });
    await assert.rejects(() => caller().plans.attach({ planId: 'plan-1', needKind: 'dining', title: 'Dinner' }), { code: 'CONFLICT' });
    await assert.rejects(() => guest().plans.respond({ planId: 'plan-1', response: 'accepted' }), { code: 'CONFLICT' });
    // Attendance and supply are reshaping too: a dead Plan is done changing.
    await assert.rejects(() => caller().plans.remove({ planId: 'plan-1', userId: 'guest-id' }), { code: 'CONFLICT' });
    await assert.rejects(() => caller().plans.detach({ planId: 'plan-1', itemId: 'item-1' }), { code: 'CONFLICT' });
  }
});

// ─── Concurrency ──────────────────────────────────────────────────────

test('Someone removed mid-call cannot answer their way back onto the Plan', async () => {
  plan.findUnique = async () => planFixture();
  let where: any = null;
  // The removal lands between the read and the write, so the guarded update
  // matches nothing.
  planParticipant.updateMany = async (args: any) => { where = args.where; return { count: 0 }; };
  await assert.rejects(() => guest().plans.respond({ planId: 'plan-1', response: 'accepted' }), { code: 'NOT_FOUND' });
  assert.deepEqual(where, { planId: 'plan-1', userId: 'guest-id', status: { not: 'removed' } });
});

test('A concurrent cancel beats a confirm, and cancelling stays terminal', async () => {
  plan.findUnique = async () => planFixture();
  // The confirm loses the race: the row is no longer proposed.
  plan.updateMany = async () => ({ count: 0 });
  plan.findUnique = async () => planFixture();
  const reread = { lifecycle: 'cancelled' };
  const original = plan.findUnique;
  let call = 0;
  plan.findUnique = async (args: any) => (call++ === 0 ? original(args) : reread);
  await assert.rejects(() => caller().plans.confirm({ planId: 'plan-1' }), { code: 'CONFLICT' });

  // A confirm that lost the race to another confirm is idempotent, not an error.
  call = 0;
  plan.findUnique = async (args: any) => (call++ === 0 ? original(args) : { lifecycle: 'confirmed' });
  assert.deepEqual(await caller().plans.confirm({ planId: 'plan-1' }), { id: 'plan-1', lifecycle: 'confirmed' });
});

test('Two concurrent invites cannot both slip past the cap', async () => {
  // A stale-in-memory cap check would let two invites to different users both
  // pass 49 and push the Plan to 51. Serializable is what stops that; the
  // test proves it by aborting a racing transaction with P2034.
  const crowd = Array.from({ length: 49 }, (_, index) => ({ userId: `guest-${index}`, role: 'guest', status: 'invited' }));
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, ...crowd] });
  user.findUnique = async () => ({ id: 'racing-invitee' });
  (db as any).$transaction = async () => {
    throw new Prisma.PrismaClientKnownRequestError('serialization conflict', { code: 'P2034', clientVersion: 'test' });
  };
  await assert.rejects(() => caller().plans.invite({ planId: 'plan-1', userId: 'racing-invitee' }), { code: 'CONFLICT' });
});

test('A concurrent invite of the same person surfaces as CONFLICT, not as a poisoned transaction', async () => {
  // The initial in-transaction re-read sees no seat, so the cap check passes
  // and create is attempted. Between our read and our create, a racing invite
  // took the seat, so create raises P2002 - the only unexpected shape here.
  plan.findUnique = async () => planFixture({ participants: [creatorSeat] });
  planParticipant.findUnique = async () => null;
  planParticipant.create = async () => {
    throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
  };
  await assert.rejects(() => caller().plans.invite({ planId: 'plan-1', userId: 'guest-id' }), { code: 'CONFLICT' });
});

test('A Plan is a coordination object, not a mailing list', async () => {
  const crowd = Array.from({ length: 50 }, (_, index) => ({ userId: `guest-${index}`, role: 'guest', status: 'invited' }));
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, ...crowd] });
  user.findUnique = async () => ({ id: 'one-too-many' });
  await assert.rejects(() => caller().plans.invite({ planId: 'plan-1', userId: 'one-too-many' }), { code: 'CONFLICT' });
});

// ─── Invite ───────────────────────────────────────────────────────────────────

test('Invite asks for no prior relationship, which is what leaves room for Spot Code', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat] });
  // A stranger with no connection, circle, or contact match is invitable.
  user.findUnique = async () => ({ id: 'stranger-id' });
  assert.deepEqual(await caller().plans.invite({ planId: 'plan-1', userId: 'stranger-id' }), { status: 'invited' });

  // The person must still exist, and the creator cannot invite themselves.
  user.findUnique = async () => null;
  await assert.rejects(() => caller().plans.invite({ planId: 'plan-1', userId: 'ghost' }), { code: 'NOT_FOUND' });
  await assert.rejects(() => caller().plans.invite({ planId: 'plan-1', userId: 'creator-id' }), { code: 'BAD_REQUEST' });
});

test('Re-inviting is idempotent, and a removed person returns to a clean invite', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, { ...guestSeat, status: 'accepted' }] });
  planParticipant.findUnique = async () => ({ status: 'accepted' });
  // Someone already going is left exactly as they are, without a write.
  let wrote = false;
  planParticipant.create = async () => { wrote = true; throw new Error('should not create'); };
  planParticipant.update = async () => { wrote = true; throw new Error('should not update'); };
  assert.deepEqual(await caller().plans.invite({ planId: 'plan-1', userId: 'guest-id' }), { status: 'accepted' });
  assert.equal(wrote, false);

  // A removed seat takes the update branch directly. Attempting create here
  // would trigger P2002 inside the transaction, which poisons every
  // subsequent statement in Postgres.
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, { ...guestSeat, status: 'removed' }] });
  planParticipant.findUnique = async () => ({ status: 'removed' });
  planParticipant.create = async () => { throw new Error('must not create over an existing seat'); };
  let updateWhere: any = null;
  planParticipant.update = async (args: any) => { updateWhere = args.where; return { status: 'invited' }; };
  assert.deepEqual(await caller().plans.invite({ planId: 'plan-1', userId: 'guest-id' }), { status: 'invited' });
  assert.deepEqual(updateWhere, { planId_userId: { planId: 'plan-1', userId: 'guest-id' } });
});

// ─── Join by link ───────────────────────────────────────────────────────────────

test('Join by link seats the holder as a guest who has yet to answer', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, guestSeat] });
  let created: any = null;
  planParticipant.create = async (args: any) => { created = args.data; return { status: args.data.status }; };
  const result = await stranger().plans.joinByToken({ token: 'tok-secret' });
  // The holder is now on the Plan as a guest who still owes an answer.
  assert.deepEqual(created, { planId: 'plan-1', userId: 'stranger-id', role: 'guest', status: 'invited' });
  assert.ok(result.participants.some((p) => p.userId === 'stranger-id' && p.role === 'guest' && p.status === 'invited'));
  // A joiner is not the creator, so the bearer token is never echoed back.
  assert.equal(result.joinToken, undefined);
});

test('The join token is handed to the creator alone, never to a guest', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, guestSeat] });
  plan.findMany = async () => [planFixture({ participants: [creatorSeat, guestSeat] })];
  // get and list expose the token on the same terms: creator only.
  assert.equal((await caller().plans.get({ planId: 'plan-1' })).joinToken, 'tok-secret');
  assert.equal((await guest().plans.get({ planId: 'plan-1' })).joinToken, undefined);
  assert.equal((await caller().plans.list()).plans[0].joinToken, 'tok-secret');
  assert.equal((await guest().plans.list()).plans[0].joinToken, undefined);
});

test('An unknown or closed link is a Plan that never existed', async () => {
  // Unknown token.
  plan.findUnique = async () => null;
  await assert.rejects(() => stranger().plans.joinByToken({ token: 'nope' }), { code: 'NOT_FOUND' });
  // Cancelled.
  plan.findUnique = async () => planFixture({ lifecycle: 'cancelled', cancelledAt: new Date() });
  await assert.rejects(() => stranger().plans.joinByToken({ token: 'tok-secret' }), { code: 'NOT_FOUND' });
  // Expired proposed.
  plan.findUnique = async () => planFixture({ expiresAt: new Date(Date.now() - 1000) });
  await assert.rejects(() => stranger().plans.joinByToken({ token: 'tok-secret' }), { code: 'NOT_FOUND' });
  // Confirmed but already ended.
  plan.findUnique = async () => planFixture({ lifecycle: 'confirmed', expiresAt: null, endsAt: new Date(Date.now() - 1000) });
  await assert.rejects(() => stranger().plans.joinByToken({ token: 'tok-secret' }), { code: 'NOT_FOUND' });
});

test('A removed guest cannot rejoin by reusing the link', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, { ...guestSeat, status: 'removed' }] });
  planParticipant.create = async () => { throw new Error('must not seat a removed guest'); };
  await assert.rejects(() => guest().plans.joinByToken({ token: 'tok-secret' }), { code: 'NOT_FOUND' });
});

test('Joining is idempotent for someone already on the Plan', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, { ...guestSeat, status: 'accepted' }] });
  planParticipant.create = async () => { throw new Error('should not create over an existing seat'); };
  const result = await guest().plans.joinByToken({ token: 'tok-secret' });
  assert.ok(result.participants.some((p) => p.userId === 'guest-id' && p.status === 'accepted'));
});

test('The link cannot push a Plan past its cap', async () => {
  const crowd = Array.from({ length: 49 }, (_, index) => ({ userId: `guest-${index}`, role: 'guest', status: 'invited' }));
  plan.findUnique = async () => planFixture({ participants: [creatorSeat, ...crowd] });
  await assert.rejects(() => stranger().plans.joinByToken({ token: 'tok-secret' }), { code: 'CONFLICT' });
});

test('Concurrent joins for the last seat surface as CONFLICT, not a poisoned transaction', async () => {
  plan.findUnique = async () => planFixture({ participants: [creatorSeat] });
  planParticipant.create = async () => {
    throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
  };
  await assert.rejects(() => stranger().plans.joinByToken({ token: 'tok-secret' }), { code: 'CONFLICT' });
});

// ─── Attach ───────────────────────────────────────────────────────────────────

test('Attaching a room requires a real published room', async () => {
  plan.findUnique = async () => planFixture();
  await assert.rejects(
    () => caller().plans.attach({ planId: 'plan-1', needKind: 'nightlife', title: 'The Basement', partyId: 'party-1' }),
    { code: 'NOT_FOUND' },
  );
  party.findFirst = async () => ({ id: 'party-1', title: 'The Basement', accessMode: 'free-rsvp' });
  assert.deepEqual(
    await caller().plans.attach({ planId: 'plan-1', needKind: 'nightlife', title: 'The Basement', partyId: 'party-1' }),
    { id: 'item-1', capability: 'book', status: 'available' },
  );
  // An item with no room behind it has nothing to derive from and stays a
  // reference, so it needs its own title.
  await assert.rejects(() => caller().plans.attach({ planId: 'plan-1', needKind: 'dining' }), { code: 'BAD_REQUEST' });
});

test('The caller cannot state the capability, so a Plan cannot advertise a booking Bytspot does not control', async () => {
  plan.findUnique = async () => planFixture();
  let seeded: any = null;
  planItem.create = async ({ data }: any) => { seeded = data; return { id: 'item-1', capability: data.capability, status: 'available' }; };

  // Capability is read off the room, not off the request. A room that only
  // forwards a request cannot be attached as bookable.
  party.findFirst = async () => ({ id: 'party-1', title: 'Rooftop', accessMode: 'private-approval' });
  await caller().plans.attach({ planId: 'plan-1', needKind: 'nightlife', title: 'Claimed As Bookable', partyId: 'party-1' });
  assert.equal(seeded.capability, 'request');
  // The room names itself, so a caller-supplied title cannot misrepresent it.
  assert.equal(seeded.title, 'Rooftop');

  // Nothing Bytspot settles behind it means a reference, never a booking.
  await caller().plans.attach({ planId: 'plan-1', needKind: 'dining', title: 'Broni Home Taste' });
  assert.equal(seeded.capability, 'details');
  assert.equal(seeded.status, undefined, 'attach must not seed a status');
});

test('Attach snapshots a Bookable handle from the supply and links it; a reference writes none', async () => {
  plan.findUnique = async () => planFixture();
  let seededItem: any = null;
  let seededBookable: any = null;
  planItem.create = async ({ data }: any) => { seededItem = data; return { id: 'item-1', capability: data.capability, status: 'available' }; };
  bookable.create = async ({ data }: any) => { seededBookable = data; return data; };

  // A paid room snapshots a book handle whose derived control is vendor, with
  // the upstream id confined to fulfillment and never embedded in the BYT- id.
  party.findFirst = async () => ({ id: 'party-1', title: 'The Basement', accessMode: 'paid-ticket', requiredMembershipTier: 'green' });
  await caller().plans.attach({ planId: 'plan-1', needKind: 'nightlife', partyId: 'party-1' });
  assert.equal(seededBookable.sourceKind, 'party_ticket');
  assert.equal(seededBookable.capability, 'book');
  assert.equal(controlFromCapability(seededBookable.capability), 'vendor');
  assert.equal(seededBookable.membershipFloor, 'green');
  assert.match(seededBookable.id, /^BYT-party_ticket-/);
  assert.ok(!seededBookable.id.includes('party-1'));
  assert.deepEqual(seededBookable.fulfillment, { partyId: 'party-1', accessMode: 'paid-ticket' });
  assert.equal(seededItem.bookableId, seededBookable.id);

  // A coffee reservation snapshots a request handle.
  coffeeReservation.findFirst = async () => ({ id: 'r-1', spot: { name: 'Highland Bakery' } });
  await caller().plans.attach({ planId: 'plan-1', needKind: 'coffee', supplyRef: { coffeeReservationId: 'r-1' } });
  assert.equal(seededBookable.sourceKind, 'coffee');
  assert.equal(seededBookable.capability, 'request');
  assert.equal(seededItem.bookableId, seededBookable.id);

  // A reference item (no supply) writes no handle at all.
  seededBookable = null;
  await caller().plans.attach({ planId: 'plan-1', needKind: 'dining', title: 'Broni Home Taste' });
  assert.equal(seededBookable, null, 'a reference must not mint a Bookable');
  assert.equal(seededItem.bookableId, null);
});

// ─── Booking spine: booked is derived from the supply (B3b) ───────────────────────────

test('itemIsBooked derives booked from the supply, never from a stored flag alone', async () => {
  // A confirmed coffee hold is booked even while the item column still reads available.
  assert.equal(itemIsBooked({ needKind: 'coffee', status: 'available', capability: 'request', coffeeReservation: { status: 'confirmed' } }), true);
  // A pending hold is not booked yet.
  assert.equal(itemIsBooked({ needKind: 'coffee', status: 'available', capability: 'request', coffeeReservation: { status: 'pending' } }), false);
  // A details reference is never booked, whatever the stored column says.
  assert.equal(itemIsBooked({ needKind: 'dining', status: 'booked', capability: 'details' }), false);
  // A cancelled item is never booked. An explicit stored booking is honored.
  assert.equal(itemIsBooked({ needKind: 'nightlife', status: 'cancelled', capability: 'book' }), false);
  assert.equal(itemIsBooked({ needKind: 'nightlife', status: 'booked', capability: 'book' }), true);
});

test('A confirmed coffee hold rolls a confirmed Plan into booked without a stored flip', async () => {
  const confirmedPlan = {
    ...planFixture({ lifecycle: 'confirmed', needs: ['coffee'] }),
    items: [{ id: 'item-1', needKind: 'coffee', title: 'Highland Bakery', partyId: null, coffeeReservationId: 'r-1', capability: 'request', status: 'available', coffeeReservation: { holdExpiresAt: null, status: 'confirmed' } }],
  };
  plan.findUnique = async () => confirmedPlan;
  const view = await caller().plans.get({ planId: 'plan-1' });
  assert.equal(view.state, 'booked');
  assert.equal(view.items[0].booked, true);
  // The stored column is untouched: booked was derived, not written.
  assert.equal(view.items[0].status, 'available');
});

test('plans.primePath ranks the Plan\u2019s own supply on Live seats and states the reason', async () => {
  plan.findUnique = async () => ({
    ...planFixture({ lifecycle: 'confirmed', partySize: 4, needs: ['nightlife'] }),
    // The creator and one guest are going; a nearer coffee alternate is attached too.
    participants: [{ userId: 'creator-id', role: 'creator', status: 'accepted' }, { userId: 'guest-id', role: 'guest', status: 'accepted' }],
    items: [
      { id: 'item-party', needKind: 'nightlife', title: 'The Basement', partyId: 'party-1', coffeeReservationId: null, capability: 'book', status: 'available', coffeeReservation: null },
      { id: 'item-coffee', needKind: 'coffee', title: 'Highland Bakery', partyId: null, coffeeReservationId: 'r-1', capability: 'request', status: 'available', coffeeReservation: { status: 'pending' } },
    ],
  });
  party.findMany = async () => [{ id: 'party-1', capacity: 40, status: 'published', admissionPaused: false, closedAt: null, endsAt: new Date(Date.now() + 6 * 60 * 60 * 1000) }];
  partyGuest.groupBy = async () => [{ partyId: 'party-1', _count: { _all: 30 } }];

  const result = await caller().plans.primePath({ planId: 'plan-1' });
  // Ranking is per need: nightlife and coffee are never weighed against each other.
  const nightlife = result.needs.find((n: any) => n.needKind === 'nightlife');
  const coffee = result.needs.find((n: any) => n.needKind === 'coffee');
  assert.ok(nightlife, 'nightlife need should exist');
  assert.ok(coffee, 'coffee need should exist');
  assert.equal(nightlife.prime?.id, 'item-party');
  assert.equal(nightlife.prime?.seats, 10);
  assert.equal(nightlife.reason, '\u2605 Prime Path \u2014 fits 4, confirmable now');
  assert.deepEqual(nightlife.alternates, []);
  assert.equal(coffee.prime?.id, 'item-coffee');
  assert.equal(coffee.reason, '\u2605 Prime Path \u2014 fits 4, confirmable now');
});

test('plans.primePath features nothing when the only attached room is full', async () => {
  plan.findUnique = async () => ({
    ...planFixture({ lifecycle: 'confirmed', partySize: 4, needs: ['nightlife'] }),
    items: [{ id: 'item-party', needKind: 'nightlife', title: 'The Basement', partyId: 'party-1', coffeeReservationId: null, capability: 'book', status: 'available', coffeeReservation: null }],
  });
  party.findMany = async () => [{ id: 'party-1', capacity: 40, status: 'published', admissionPaused: false, closedAt: null, endsAt: new Date(Date.now() + 6 * 60 * 60 * 1000) }];
  partyGuest.groupBy = async () => [{ partyId: 'party-1', _count: { _all: 40 } }];

  const result = await caller().plans.primePath({ planId: 'plan-1' });
  assert.deepEqual(result.needs, [{ needKind: 'nightlife', prime: null, alternates: [], reason: null }]);
});

test('A granted party guest rolls the creator\u2019s Plan into booked, scoped to that creator', async () => {
  const partyPlan = {
    ...planFixture({ lifecycle: 'confirmed', needs: ['nightlife'] }),
    items: [{ id: 'item-1', needKind: 'nightlife', title: 'The Basement', partyId: 'party-1', coffeeReservationId: null, capability: 'book', status: 'available', coffeeReservation: null }],
  };
  plan.findUnique = async () => partyPlan;

  // The creator (creator-id) holds granted access to party-1.
  let queried: any = null;
  partyGuest.findMany = async (args: any) => { queried = args; return [{ partyId: 'party-1', userId: 'creator-id' }]; };
  const view = await caller().plans.get({ planId: 'plan-1' });
  assert.equal(view.state, 'booked');
  assert.equal(view.items[0].booked, true);
  assert.equal(view.items[0].status, 'available');
  // The lookup is scoped to the creator and to granted access only.
  assert.equal(queried.where.accessGranted, true);
  assert.deepEqual(queried.where.OR, [{ partyId: 'party-1', userId: 'creator-id' }]);

  // Another user's granted access to the same party does not book this Plan.
  partyGuest.findMany = async () => [{ partyId: 'party-1', userId: 'someone-else' }];
  const stillOpen = await caller().plans.get({ planId: 'plan-1' });
  assert.equal(stillOpen.state, 'confirmed');
  assert.equal(stillOpen.items[0].booked, false);
});

test('detach refuses a derived-booked item, not only a stored one', async () => {
  plan.findUnique = async () => ({
    ...planFixture(),
    items: [{ id: 'item-1', needKind: 'coffee', title: 'Highland Bakery', partyId: null, coffeeReservationId: 'r-1', capability: 'request', status: 'available', coffeeReservation: { holdExpiresAt: null, status: 'confirmed' } }],
  });
  await assert.rejects(() => caller().plans.detach({ planId: 'plan-1', itemId: 'item-1' }), { code: 'CONFLICT' });
});

// ─── Booking spine: every booking is a Plan of one (B3a) ───────────────────────────

test('createSolo wraps one supply in a single-need Plan of one, deriving capability and linking the handle', async () => {
  let planData: any = null, itemData: any = null, bookableData: any = null;
  plan.create = async ({ data }: any) => { planData = data; return { id: 'plan-solo' }; };
  planItem.create = async ({ data }: any) => { itemData = data; return { id: 'item-solo', capability: data.capability, status: 'available' }; };
  bookable.create = async ({ data }: any) => { bookableData = data; return data; };
  party.findFirst = async () => ({ id: 'party-1', title: 'The Basement', accessMode: 'paid-ticket', requiredMembershipTier: 'green' });

  const res = await caller().plans.createSolo({ idempotencyKey, needKind: 'nightlife', supplyRef: { partyId: 'party-1' } });
  assert.equal(res.id, 'plan-solo');
  // A single-need Plan, seated by the creator, named after the supply.
  assert.deepEqual(planData.needs, ['nightlife']);
  assert.equal(planData.title, 'The Basement');
  assert.equal(planData.creatorUserId, 'creator-id');
  // The one item carries the derived capability and links the snapshot handle.
  assert.equal(itemData.capability, 'book');
  assert.equal(itemData.partyId, 'party-1');
  assert.equal(itemData.bookableId, bookableData.id);
  assert.match(bookableData.id, /^BYT-party_ticket-/);
  // The skeleton settles nothing: the item is never seeded booked.
  assert.equal(itemData.status, undefined);
});

test('createSolo is idempotent: a replayed key returns the same Plan and writes nothing new', async () => {
  plan.findUnique = async () => ({ id: 'plan-existing' });
  let created = false;
  plan.create = async () => { created = true; return { id: 'plan-new' }; };
  const res = await caller().plans.createSolo({ idempotencyKey, needKind: 'coffee', supplyRef: { coffeeReservationId: 'r-1' } });
  assert.equal(res.id, 'plan-existing');
  assert.equal(created, false, 'a replay must not create a second Plan');
});

test('createSolo refuses an empty Plan and refuses two supplies at once', async () => {
  await assert.rejects(
    () => caller().plans.createSolo({ idempotencyKey, needKind: 'dining', title: 'Just Vibes', supplyRef: {} }),
    { code: 'BAD_REQUEST' },
  );
  await assert.rejects(
    () => caller().plans.createSolo({ idempotencyKey, needKind: 'coffee', supplyRef: { partyId: 'p-1', coffeeReservationId: 'r-1' } }),
    { code: 'BAD_REQUEST' },
  );
});

test('createSolo surfaces a supply already on another Plan as a conflict', async () => {
  coffeeReservation.findFirst = async () => ({ id: 'r-1', spot: { name: 'Highland Bakery' } });
  planItem.create = async () => { throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }); };
  await assert.rejects(
    () => caller().plans.createSolo({ idempotencyKey, needKind: 'coffee', supplyRef: { coffeeReservationId: 'r-1' } }),
    { code: 'CONFLICT' },
  );
});

// ─── Attach: second real bookable ────────────────────────────────────────────

test('Attach accepts a generic supplyRef and refuses to carry two supplies at once', async () => {
  plan.findUnique = async () => planFixture();
  await assert.rejects(
    () => caller().plans.attach({ planId: 'plan-1', needKind: 'coffee', supplyRef: { partyId: 'p-1', coffeeReservationId: 'r-1' } }),
    { code: 'BAD_REQUEST' },
  );

  // supplyRef.partyId keeps the exact behaviour of the legacy top-level shape.
  party.findFirst = async () => ({ id: 'p-1', title: 'The Basement', accessMode: 'free-rsvp' });
  let seeded: any = null;
  planItem.create = async ({ data }: any) => { seeded = data; return { id: 'item-1', capability: data.capability, status: 'available' }; };
  await caller().plans.attach({ planId: 'plan-1', needKind: 'nightlife', supplyRef: { partyId: 'p-1' } });
  assert.equal(seeded.capability, 'book');
  assert.equal(seeded.partyId, 'p-1');
  assert.equal(seeded.coffeeReservationId, null);
});

test('Attaching a coffee reservation derives request, uses the spot name, and refuses another caller', async () => {
  plan.findUnique = async () => planFixture();

  // A reservation the caller does not own is indistinguishable from missing;
  // findFirst is scoped by requestedByUserId in the router, so a match by
  // reservation id alone is not enough.
  coffeeReservation.findFirst = async () => null;
  await assert.rejects(
    () => caller().plans.attach({ planId: 'plan-1', needKind: 'coffee', supplyRef: { coffeeReservationId: 'r-1' } }),
    { code: 'NOT_FOUND' },
  );

  // A reservation the caller owns lands on the item; the spot names itself so
  // a caller-supplied title cannot misrepresent it, and capability is request.
  coffeeReservation.findFirst = async () => ({ id: 'r-1', spot: { name: 'Highland Bakery' } });
  let seeded: any = null;
  planItem.create = async ({ data }: any) => { seeded = data; return { id: 'item-1', capability: data.capability, status: 'available' }; };
  const result = await caller().plans.attach({ planId: 'plan-1', needKind: 'coffee', title: 'Caller-Overrides-Refused', supplyRef: { coffeeReservationId: 'r-1' } });
  assert.equal(result.capability, 'request');
  assert.equal(seeded.capability, 'request');
  assert.equal(seeded.title, 'Highland Bakery');
  assert.equal(seeded.coffeeReservationId, 'r-1');
  assert.equal(seeded.partyId, null);

  // A racing attach of the same reservation to another Plan trips the
  // unique constraint on plan_items.coffee_reservation_id.
  planItem.create = async () => { throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }); };
  await assert.rejects(
    () => caller().plans.attach({ planId: 'plan-1', needKind: 'coffee', supplyRef: { coffeeReservationId: 'r-1' } }),
    { code: 'CONFLICT' },
  );
});

test('Detach cancels the item and refuses to strand a booking', async () => {
  plan.findUnique = async () => planFixture({ items: [{ id: 'item-1', needKind: 'dining', title: 'Dinner', status: 'available' }] });
  assert.deepEqual(await caller().plans.detach({ planId: 'plan-1', itemId: 'item-1' }), { status: 'cancelled' });
  await assert.rejects(() => caller().plans.detach({ planId: 'plan-1', itemId: 'missing' }), { code: 'NOT_FOUND' });

  // A booking landing between the read and the write is not silently stranded.
  let where: any = null;
  planItem.updateMany = async (args: any) => { where = args.where; return { count: 0 }; };
  await assert.rejects(() => caller().plans.detach({ planId: 'plan-1', itemId: 'item-1' }), { code: 'CONFLICT' });
  assert.deepEqual(where, { id: 'item-1', status: { not: 'booked' } });
});

// ─── Read model ───────────────────────────────────────────────────────────────

test('Get returns the derived truth beside the stored lifecycle', async () => {
  plan.findUnique = async () => planFixture({
    lifecycle: 'confirmed',
    expiresAt: null,
    needs: ['dining', 'parking'],
    participants: [creatorSeat, guestSeat, { userId: 'third-id', role: 'guest', status: 'declined' }],
    items: [{ id: 'item-1', needKind: 'dining', title: 'Dinner', partyId: null, capability: 'book', status: 'booked' }],
  });
  const result = await caller().plans.get({ planId: 'plan-1' });
  assert.equal(result.lifecycle, 'confirmed');
  assert.equal(result.state, 'booked');
  assert.deepEqual(result.openNeeds, ['parking']);
  assert.deepEqual(result.readiness, { going: 1, maybe: 0, pending: 1, declined: 1, total: 3 });
});

test('Get returns reservation summary on coffee-backed items, and null everywhere else', async () => {
  // A hold countdown on the Plans row needs the reservation's expiry and
  // status without a second round-trip. The reservation summary is present
  // only when the item points at one; a room-backed item stays null.
  const holdExpiresAt = new Date('2026-09-03T20:15:00Z');
  plan.findUnique = async () => planFixture({
    items: [
      { id: 'item-1', needKind: 'dining', title: 'Dinner', partyId: 'party-1', coffeeReservationId: null, capability: 'book', status: 'available', coffeeReservation: null },
      { id: 'item-2', needKind: 'coffee', title: 'Highland Bakery', partyId: null, coffeeReservationId: 'r-1', capability: 'request', status: 'pending', coffeeReservation: { holdExpiresAt, status: 'pending' } },
    ],
  });
  const result = await caller().plans.get({ planId: 'plan-1' });
  const [room, coffee] = result.items;
  assert.equal(room.reservation, null);
  assert.deepEqual(coffee.reservation, { holdExpiresAt, status: 'pending' });
});

test('List returns only plans the caller still has a seat on', async () => {
  let where: any = null;
  plan.findMany = async (args: any) => { where = args.where; return [planFixture()]; };
  const result = await caller().plans.list();
  assert.equal(result.plans.length, 1);
  assert.deepEqual(where, { participants: { some: { userId: 'creator-id', status: { not: 'removed' } } } });
});
