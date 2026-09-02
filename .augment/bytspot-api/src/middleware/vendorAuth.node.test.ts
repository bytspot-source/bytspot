import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../lib/db';
import { requireCapability, requireVendorSeat, SELLER_HEADER } from './vendorAuth';
import { signVendorAccessToken } from '../vendor/accessToken';

const seller = (over: Record<string, unknown> = {}) => ({
  id: 'sel_1',
  state: 'ACTIVE',
  legalName: 'Midtown Table',
  contactEmail: 'owner@midtown.example',
  payoutReference: null,
  payoutStatus: 'pending',
  payoutLast4: null,
  payoutDetail: null,
  locations: [],
  ...over,
});

const seat = (over: Record<string, unknown> = {}) => ({
  id: 'seat_1',
  sellerId: 'sel_1',
  userId: 'usr_1',
  role: 'owner',
  state: 'ACTIVE',
  locationIds: [],
  bookableIds: [],
  seller: seller(),
  ...over,
});

/** Captures what the middleware answered, or that it passed the request on. */
function spyResponse() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, sent };
}

const request = (over: Record<string, unknown> = {}): Request =>
  ({
    headers: { authorization: `Bearer ${signVendorAccessToken({ userId: 'usr_1', email: 'a@b.c' })}` },
    ...over,
  }) as unknown as Request;

let queried: unknown;

beforeEach(() => {
  queried = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.vendorSeat as any).findMany = async (args: unknown) => {
    queried = args;
    return [seat()];
  };
});

test('a request with no bearer token is refused before any lookup', async () => {
  const { res, sent } = spyResponse();
  let passed = false;
  await requireVendorSeat({ headers: {} } as Request, res, (() => {
    passed = true;
  }) as NextFunction);

  assert.equal(sent.status, 401);
  assert.equal(passed, false);
  assert.equal(queried, undefined, 'an unauthenticated request must not reach the database');
});

test('a consumer token does not reach a vendor route', async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const { config } = await import('../config');
  const consumer = jwt.sign({ userId: 'usr_1', email: 'a@b.c' }, config.jwtSecret, { expiresIn: 900 });

  const { res, sent } = spyResponse();
  await requireVendorSeat(request({ headers: { authorization: `Bearer ${consumer}` } }), res, (() => {
    assert.fail('a consumer token must not pass');
  }) as NextFunction);
  assert.equal(sent.status, 401);
});

test('the seat is looked up by the id the token proved, never by the body', async () => {
  const req = request({ body: { sellerId: 'sel_someone_else' } });
  await requireVendorSeat(req, spyResponse().res, (() => {}) as NextFunction);

  const where = (queried as { where: Record<string, unknown> }).where;
  assert.equal(where.userId, 'usr_1', 'the lookup must be keyed on the token');
  // A vendor id in a payload is a request to act on someone else's business.
  assert.ok(!('sellerId' in where) || where.sellerId === undefined);
});

test('naming another business you hold no seat at reads as not existing', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.vendorSeat as any).findMany = async () => [];

  const { res, sent } = spyResponse();
  await requireVendorSeat(request({ headers: { authorization: request().headers.authorization, [SELLER_HEADER]: 'sel_theirs' } }), res, (() => {
    assert.fail('a cross-tenant request must not pass');
  }) as NextFunction);

  // Indistinguishable from a business that does not exist, so a caller probing
  // ids cannot tell a real one from a fabricated one.
  assert.equal(sent.status, 403);
  assert.deepEqual(sent.body, { error: 'No seat at this business' });
});

test('only active seats are considered', async () => {
  await requireVendorSeat(request(), spyResponse().res, (() => {}) as NextFunction);
  // An invited seat can sign in — the console shows the invitation — but it
  // cannot act, so it is not a seat for the purposes of a write.
  assert.equal((queried as { where: { state: string } }).where.state, 'ACTIVE');
});

test('a person with two businesses must name one rather than have it guessed', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.vendorSeat as any).findMany = async () => [seat(), seat({ id: 'seat_2', sellerId: 'sel_2' })];

  const { res, sent } = spyResponse();
  await requireVendorSeat(request(), res, (() => {
    assert.fail('an ambiguous request must not pass');
  }) as NextFunction);

  assert.equal(sent.status, 400);
});

test('a sole seat needs no header', async () => {
  const req = request();
  let passed = false;
  await requireVendorSeat(req, spyResponse().res, (() => {
    passed = true;
  }) as NextFunction);

  assert.ok(passed);
  assert.equal(req.vendor?.seller.id, 'sel_1');
});

test('a closed business is not a console anyone can open', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.vendorSeat as any).findMany = async () => [seat({ seller: seller({ state: 'CLOSED' }) })];

  const { res, sent } = spyResponse();
  await requireVendorSeat(request(), res, (() => {
    assert.fail('a closed business must not pass');
  }) as NextFunction);
  assert.equal(sent.status, 403);
});

test('capabilities come from role and business state together', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.vendorSeat as any).findMany = async () => [seat({ seller: seller({ state: 'SUSPENDED' }) })];

  const req = request();
  await requireVendorSeat(req, spyResponse().res, (() => {}) as NextFunction);

  // An owner at a suspended business keeps the door open and stops selling.
  assert.ok(req.vendor?.capabilities.includes('CHECK_IN'));
  assert.ok(!req.vendor?.capabilities.includes('SELL'));
});

test('a seat without the capability is refused the write', () => {
  const { res, sent } = spyResponse();
  const req = { vendor: { capabilities: ['CHECK_IN', 'VERIFY'] } } as unknown as Request;

  requireCapability('SELL')(req, res, (() => assert.fail('door staff must not write')) as NextFunction);
  assert.equal(sent.status, 403);

  let passed = false;
  requireCapability('CHECK_IN')(req, res, (() => {
    passed = true;
  }) as NextFunction);
  assert.ok(passed);
});

test('a request that never reached the seat middleware has no capabilities', () => {
  // Fail closed: an unset context must not read as an unrestricted one.
  const { res, sent } = spyResponse();
  requireCapability('SELL')({} as Request, res, (() => assert.fail('must not pass')) as NextFunction);
  assert.equal(sent.status, 403);
});
