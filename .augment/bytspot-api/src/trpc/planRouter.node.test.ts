import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import type { Context } from './context';
import { capabilityForAccessMode, capabilityForSupply, isProposedPlanExpired, openNeeds, planDisplayState, planReadiness } from './planRouter';

const idempotencyKey = '00000000-0000-4000-8000-000000000010';
const createCaller = createCallerFactory(appRouter);
const plan = db.plan as any;
const planParticipant = db.planParticipant as any;
const planItem = db.planItem as any;
const party = db.party as any;
const user = db.user as any;
const coffeeReservation = db.coffeeReservation as any;

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
  planItem.update = async () => ({ id: 'item-1', status: 'cancelled' });
  planItem.updateMany = async () => ({ count: 1 });
  party.findFirst = async () => null;
  user.findUnique = async () => ({ id: 'guest-id' });
  coffeeReservation.findFirst = async () => null;
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

test('List returns only plans the caller still has a seat on', async () => {
  let where: any = null;
  plan.findMany = async (args: any) => { where = args.where; return [planFixture()]; };
  const result = await caller().plans.list();
  assert.equal(result.plans.length, 1);
  assert.deepEqual(where, { participants: { some: { userId: 'creator-id', status: { not: 'removed' } } } });
});
