import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type Stripe from 'stripe';
import vendorSetupRouter, { businessBlockers, locationBlockers, normalizePhone, normalizeWebsite } from './vendorSetup';
import { db } from '../lib/db';
import { signVendorAccessToken } from '../vendor/accessToken';
import { LOCATION_DEFAULTS, locationOperation } from '../vendor/contract';
import { ensureAccount, onboardingLink, statusFrom, storedPayout } from '../vendor/payout';

const place = (over: Partial<Parameters<typeof locationBlockers>[0]> = {}) => ({
  label: 'Main',
  kind: 'fixed' as const,
  address: '1 Peachtree St NE, Atlanta, GA 30303',
  lat: 33.7866,
  lng: -84.3833,
  ...over,
});

test('a complete fixed place has nothing wrong with it', () => {
  assert.deepEqual(locationBlockers(place()), []);
});

test('a place guests come to needs an address', () => {
  assert.deepEqual(locationBlockers(place({ address: '   ' })), ['This kind of place needs an address']);
});

test('a visiting provider needs no address but does need a radius', () => {
  assert.deepEqual(locationBlockers(place({ kind: 'visiting', address: undefined, radiusMiles: 10 })), []);
  assert.deepEqual(locationBlockers(place({ kind: 'visiting', address: undefined, radiusMiles: 0 })), [
    'Say how far you travel',
  ]);
});

test('an absent radius falls back to the catalog default rather than failing', () => {
  assert.deepEqual(locationBlockers(place({ kind: 'visiting', address: undefined })), []);
});

test('travel is capped at the distance the catalog says', () => {
  const over = LOCATION_DEFAULTS.maxRadiusMiles + 1;
  assert.deepEqual(locationBlockers(place({ kind: 'mobile', radiusMiles: over })), [
    `We cap travel at ${LOCATION_DEFAULTS.maxRadiusMiles} miles`,
  ]);
  assert.deepEqual(locationBlockers(place({ kind: 'mobile', radiusMiles: LOCATION_DEFAULTS.maxRadiusMiles })), []);
});

test('an unpinned place is refused, however complete the rest is', () => {
  // A failed geocode that nobody checked looks exactly like this.
  assert.deepEqual(locationBlockers(place({ lat: 0, lng: 0 })), ['Pick an address so we can place the pin']);
  assert.deepEqual(locationBlockers(place({ lat: 91 })), ['That pin is not a real coordinate']);
  assert.deepEqual(locationBlockers(place({ lat: Number.NaN })), ['Pick an address so we can place the pin']);
});

test('an unknown kind is refused rather than treated as the default', () => {
  assert.deepEqual(locationBlockers(place({ kind: 'warehouse' as never })), ['That is not a kind of place']);
});

test('the transition table is what decides, and closed is terminal', () => {
  assert.deepEqual(locationOperation('ACTIVATE_LOCATION')?.from, ['DRAFT', 'PAUSED']);
  assert.deepEqual(locationOperation('PAUSE_LOCATION')?.from, ['ACTIVE']);
  // Nothing transitions out of CLOSED, because no operation lists it as a from.
  for (const id of ['ACTIVATE_LOCATION', 'PAUSE_LOCATION', 'CLOSE_LOCATION'] as const) {
    assert.ok(!locationOperation(id)?.from.includes('CLOSED'), `${id} must not resurrect a closed place`);
  }
});

const account = (over: Partial<Stripe.Account> = {}) =>
  ({ payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] }, ...over }) as Stripe.Account;

test('only an enabled account with nothing outstanding is active', () => {
  assert.deepEqual(statusFrom(account()), { status: 'active' });
});

test('a finished form is not an active account', () => {
  // details_submitted is where a business goes live and then fails to be paid.
  const reviewing = statusFrom(account({ payouts_enabled: false }));
  assert.equal(reviewing.status, 'pending');
  assert.match(reviewing.detail ?? '', /reviewing/);
});

test('an outstanding requirement holds an otherwise enabled account back', () => {
  const due = statusFrom(account({ requirements: { currently_due: ['individual.id_number'] } as never }));
  assert.notEqual(due.status, 'active');
});

test('a disabled account is restricted, with the reason made readable', () => {
  const blocked = statusFrom(
    account({ payouts_enabled: false, requirements: { disabled_reason: 'requirements.past_due' } as never }),
  );
  assert.equal(blocked.status, 'restricted');
  // Processor reason codes are dot-cased identifiers; this one is shown.
  assert.equal(blocked.detail, 'Requirements past due');
});

test('a business with no processor account has no payout, not a pending one', () => {
  assert.equal(storedPayout({ payoutReference: null } as never), undefined);
});

test('an unrecognised stored status reads as pending, never as active', () => {
  const payout = storedPayout({
    payoutReference: 'acct_1',
    payoutStatus: 'something_new',
    payoutLast4: null,
    payoutDetail: null,
  } as never);
  assert.equal(payout?.status, 'pending');
});

test('a phone is kept as "+" and digits, and refused when it cannot be dialled', () => {
  assert.equal(normalizePhone('(404) 555-0123'), '4045550123');
  assert.equal(normalizePhone('+1 404-555-0123'), '+14045550123');
  assert.equal(normalizePhone('555'), undefined);
  assert.equal(normalizePhone(''), undefined);
  assert.deepEqual(locationBlockers(place({ phone: 'call us' })), ['That phone number does not look right']);
  assert.deepEqual(locationBlockers(place({ phone: '404 555 0123' })), []);
});

test('a website is an absolute http(s) URL; a bare domain gets https', () => {
  assert.equal(normalizeWebsite('peachtable.com'), 'https://peachtable.com/');
  assert.equal(normalizeWebsite('http://peachtable.com/menu'), 'http://peachtable.com/menu');
  // Only a web page opens from the Website chip.
  assert.equal(normalizeWebsite('javascript:alert(1)'), undefined);
  assert.equal(normalizeWebsite('ftp://peachtable.com'), undefined);
  assert.equal(normalizeWebsite('localhost'), undefined);
  assert.equal(normalizeWebsite('https://user:pass@peachtable.com'), undefined);
  assert.deepEqual(locationBlockers(place({ website: 'not a site' })), ['That website does not look right']);
  // Both are optional.
  assert.deepEqual(locationBlockers(place({ phone: '', website: '' })), []);
});

test('a new place is created under our id, even when the console sends a placeholder', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = (model: unknown) => model as any;
  const seller = {
    id: 'sel_1', state: 'DRAFT', legalName: 'Fulzip Inc', contactEmail: 'owner@fulzip.example',
    businessMode: 'standard', payoutReference: null, payoutStatus: null, payoutLast4: null, payoutDetail: null,
  };
  const created: Record<string, unknown>[] = [];
  const updatedWhere: unknown[] = [];
  stub(db.vendorSeat).findMany = async () => [
    { id: 'seat_1', sellerId: 'sel_1', userId: 'usr_1', role: 'owner', state: 'ACTIVE', locationIds: [], bookableIds: [], seller: { ...seller, locations: [] } },
  ];
  stub(db.vendorLocation).updateMany = async (args: { where: unknown }) => {
    updatedWhere.push(args.where);
    return { count: 0 };
  };
  stub(db.vendorLocation).create = async (args: { data: Record<string, unknown> }) => {
    created.push(args.data);
    return args.data;
  };
  stub(db.vendorLocation).findMany = async () => [];
  stub(db.vendorSeller).findUnique = async () => ({ ...seller, locations: [] });
  stub(db.vendorSeller).update = async (args: { data: Record<string, unknown> }) => ({ ...seller, ...args.data });

  const app = express();
  app.use(express.json());
  app.use(vendorSetupRouter);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const save = (body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:${port}/vendor/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${signVendorAccessToken({ userId: 'usr_1', email: 'owner@fulzip.example' })}`,
      },
      body: JSON.stringify({ ...place(), timezone: 'America/New_York', ...body }),
    });
  try {
    const live = await save({ id: 'loc_1790000000000', state: 'ACTIVE' });
    assert.equal(live.status, 200);
    // The console reads the business's state from the profile, not from sign-in.
    const body = (await live.json()) as { state: string; verifiedAt?: string };
    assert.equal(body.state, 'PENDING');
    assert.equal(body.verifiedAt, undefined);
    // Tried as an edit first, scoped to this business, then created.
    assert.deepEqual(updatedWhere, [{ id: 'loc_1790000000000', sellerId: 'sel_1' }]);
    assert.equal(created.length, 1);
    assert.equal(created[0].id, undefined, 'the console placeholder is never stored as the id');
    assert.equal(created[0].sellerId, 'sel_1');
    assert.equal(created[0].state, 'ACTIVE');

    // Only ACTIVE is honoured; anything else starts as a draft.
    assert.equal((await save({ state: 'PAUSED' })).status, 200);
    assert.equal(created[1].state, 'DRAFT');
  } finally {
    server.close();
  }
});

test('a business kind and added categories must be ones the contract lists', () => {
  assert.deepEqual(businessBlockers({ businessKind: 'valet', extraBookableTypes: ['stay'] }), []);
  assert.deepEqual(businessBlockers({ businessKind: 'spaceport' }), ['Pick one of the kinds listed']);
  assert.deepEqual(businessBlockers({ extraBookableTypes: ['parking', 'yachts'] }), ['That category does not exist']);
  assert.deepEqual(businessBlockers({}), []);
});

function fakeStripe(v2LinkFails = false) {
  const calls: { v2Accounts: any[]; v2Links: any[]; v1Links: any[] } = { v2Accounts: [], v2Links: [], v1Links: [] };
  const stripe = {
    v2: { core: {
      accounts: { create: async (params: any, options: any) => { calls.v2Accounts.push({ params, options }); return { id: 'acct_v2' }; } },
      accountLinks: { create: async (params: any) => {
        calls.v2Links.push(params);
        if (v2LinkFails) throw new Error('v1 account');
        return { url: 'https://connect.stripe.com/setup/v2' };
      } },
    } },
    accounts: { create: async () => assert.fail('the legacy v1 type: express call is refused by Stripe for this platform') },
    accountLinks: { create: async (params: any) => { calls.v1Links.push(params); return { url: 'https://connect.stripe.com/setup/v1' }; } },
  };
  return { stripe: stripe as unknown as Stripe, calls };
}

test('a vendor payout account is a v2 transfer recipient with Bytspot paying fees and losses', async () => {
  const { stripe, calls } = fakeStripe();
  const saved: any[] = [];
  const original = db.vendorSeller.update;
  (db.vendorSeller as any).update = async (args: any) => { saved.push(args); return {}; };
  try {
    const id = await ensureAccount({ id: 'sel_1', legalName: 'buzzCall', contactEmail: 'owner@example.test', payoutReference: null } as never, stripe);
    assert.equal(id, 'acct_v2');
    const { params, options } = calls.v2Accounts[0];
    assert.equal(params.type, undefined);
    assert.equal(params.dashboard, 'express');
    assert.deepEqual(params.defaults.responsibilities, { fees_collector: 'application', losses_collector: 'application' });
    assert.deepEqual(params.configuration, { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } });
    assert.equal(params.contact_email, 'owner@example.test');
    assert.deepEqual(params.metadata, { sellerId: 'sel_1' });
    assert.equal(options.idempotencyKey, 'vendor-payout-account:sel_1');
    assert.deepEqual(saved[0].data, { payoutReference: 'acct_v2', payoutStatus: 'pending' });

    assert.equal(await ensureAccount({ id: 'sel_1', payoutReference: 'acct_existing' } as never, stripe), 'acct_existing');
    assert.equal(calls.v2Accounts.length, 1, 'an existing account is reused');
  } finally {
    (db.vendorSeller as any).update = original;
  }
});

test('onboarding uses a v2 link for the recipient, and falls back to v1 for an older account', async () => {
  const { stripe: v2, calls: v2Calls } = fakeStripe();
  const { stripeHandle } = await import('../vendor/payout');
  const originalClient = stripeHandle.client;
  try {
    stripeHandle.client = () => v2;
    const handoff = await onboardingLink({ id: 'sel_1', payoutReference: 'acct_v2' } as never, 'https://vendor.bytspot.app');
    assert.deepEqual(handoff, { reference: 'acct_v2', url: 'https://connect.stripe.com/setup/v2' });
    assert.deepEqual(v2Calls.v2Links[0].use_case.account_onboarding, {
      configurations: ['recipient'], refresh_url: 'https://vendor.bytspot.app/payout/retry', return_url: 'https://vendor.bytspot.app/payout/done',
    });
    assert.equal(v2Calls.v1Links.length, 0);

    const { stripe: old, calls: oldCalls } = fakeStripe(true);
    stripeHandle.client = () => old;
    const fallback = await onboardingLink({ id: 'sel_2', payoutReference: 'acct_old' } as never, 'https://vendor.bytspot.app');
    assert.equal(fallback?.url, 'https://connect.stripe.com/setup/v1');
    assert.equal(oldCalls.v1Links[0].account, 'acct_old');
  } finally {
    stripeHandle.client = originalClient;
  }
});
