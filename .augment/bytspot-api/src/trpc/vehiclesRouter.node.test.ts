import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const authenticatedContext: Context = { user: { userId: 'me', email: 'me@bytspot.com' }, clientRateLimitKey: 'test-vehicles-client' };
const vehicle = db.vehicle as any;
const user = db.user as any;

function caller(context = authenticatedContext) {
  return createCaller(context);
}

const input = {
  type: 'sedan' as const,
  make: 'Tesla',
  model: 'Model 3',
  year: 2026,
  color: 'Midnight Blue',
  licensePlate: 'BYT-424',
  transmissionType: 'automatic' as const,
  trunkCategory: 'full' as const,
};

beforeEach(() => {
  vehicle.findMany = async () => [];
  vehicle.create = async ({ data }: any) => ({ id: 'veh_1', ...data });
  vehicle.updateMany = async () => ({ count: 1 });
  vehicle.deleteMany = async () => ({ count: 1 });
});

// The JSON array made every mutation a read-modify-write of the whole list, so
// a concurrent add wrote back a stale copy and lost the other vehicle. A write
// that touches only the row it names cannot do that. Reading the user row at
// all is the tell, so that is what this asserts.
test('Adding a vehicle writes one row and never reads the vehicle list', async () => {
  let userRead = false;
  user.findUnique = async () => {
    userRead = true;
    return { vehicles: [] };
  };
  let createData: any;
  vehicle.create = async ({ data }: any) => {
    createData = data;
    return { id: 'veh_1', ...data };
  };

  const added = await caller().user.vehicles.add(input);

  assert.equal(userRead, false, 'add must not read-modify-write the user row');
  assert.equal(createData.userId, 'me');
  assert.equal(createData.make, 'Tesla');
  // The id comes from the database, not from `v_${Date.now()}`, which collided
  // for any two vehicles created within the same millisecond.
  assert.equal(added.id, 'veh_1');
  assert.ok(!String(added.id).startsWith('v_'));
});

// Two adds in the same millisecond used to produce two vehicles sharing one
// id, after which `update` edited whichever the array scan reached first and
// `remove` deleted both. Distinct ids are the whole point of the table.
test('Vehicles created in the same millisecond get distinct ids', async () => {
  let n = 0;
  vehicle.create = async ({ data }: any) => ({ id: `veh_${++n}`, ...data });

  const [first, second] = await Promise.all([
    caller().user.vehicles.add(input),
    caller().user.vehicles.add({ ...input, licensePlate: 'BYT-425' }),
  ]);

  assert.notEqual(first.id, second.id);
});

// An id is now globally unique, so it is also guessable across accounts. Both
// mutations must be scoped by the caller, not just by the id they were handed.
test('Update and remove are scoped to the caller, not just the id', async () => {
  let updateWhere: any;
  vehicle.updateMany = async ({ where }: any) => {
    updateWhere = where;
    return { count: 1 };
  };
  await caller().user.vehicles.update({ id: 'veh_1', ...input });
  assert.deepEqual(updateWhere, { id: 'veh_1', userId: 'me' });

  let deleteWhere: any;
  vehicle.deleteMany = async ({ where }: any) => {
    deleteWhere = where;
    return { count: 1 };
  };
  await caller().user.vehicles.remove({ id: 'veh_1' });
  assert.deepEqual(deleteWhere, { id: 'veh_1', userId: 'me' });
});

// Another member's vehicle must be indistinguishable from one that does not
// exist: NOT_FOUND, never a silent success and never an edit.
test('Updating a vehicle the caller does not own is NOT_FOUND', async () => {
  vehicle.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().user.vehicles.update({ id: 'veh_other', ...input }), { code: 'NOT_FOUND' });
});

test('Listing returns only the caller rows, ordered, and never the legacy column', async () => {
  let listArgs: any;
  vehicle.findMany = async (args: any) => {
    listArgs = args;
    return [{ id: 'veh_1', ...input }];
  };
  let userRead = false;
  user.findUnique = async () => {
    userRead = true;
    return { vehicles: [{ id: 'v_1', make: 'Legacy' }] };
  };

  const listed = await caller().user.vehicles.list();

  assert.equal(userRead, false, 'list must not fall back to users.vehicles');
  assert.equal(listArgs.where.userId, 'me');
  assert.deepEqual(listArgs.orderBy, { createdAt: 'asc' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'veh_1');
});

// Removing something already gone satisfies the caller's intent, so it stays a
// success rather than a 404 an iOS retry would surface as a failure.
test('Removing an absent vehicle succeeds', async () => {
  vehicle.deleteMany = async () => ({ count: 0 });
  assert.deepEqual(await caller().user.vehicles.remove({ id: 'veh_gone' }), { success: true });
});

test('Every vehicle procedure refuses an anonymous caller', async () => {
  const anonymous = { clientRateLimitKey: 'test-vehicles-anon' } as Context;
  await assert.rejects(() => createCaller(anonymous).user.vehicles.list(), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => createCaller(anonymous).user.vehicles.add(input), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => createCaller(anonymous).user.vehicles.update({ id: 'veh_1', ...input }), { code: 'UNAUTHORIZED' });
  await assert.rejects(() => createCaller(anonymous).user.vehicles.remove({ id: 'veh_1' }), { code: 'UNAUTHORIZED' });
});
