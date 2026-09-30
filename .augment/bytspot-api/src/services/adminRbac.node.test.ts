import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminGroupFor, assertBytspotAdmin, logAdminBootstrapIds, ADMIN_GROUPS } from './adminRbac';
import { config } from '../config';
import { db } from '../lib/db';
import { createCallerFactory, resetLocalRateLimitForTests } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import { categoryForPlaceType, pitchNumbersFor } from '../trpc/adminPlacesRouter';
import { vendorConsoleOrigin } from '../trpc/adminVendorsRouter';
import { tableBookingLinkFor } from './tableBookingLinks';

async function captureBootstrap(emails: string, rows: Array<{ id: string; email: string }>): Promise<string> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await logAdminBootstrapIds(async () => rows, emails);
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

const allowlist = 'usr_ops:BYTSPOT_ADMIN,usr_oncall:INTERNAL_OPS,usr_bare';

test('allowlist maps user ids to their declared admin group', () => {
  assert.equal(adminGroupFor('usr_ops', allowlist), 'BYTSPOT_ADMIN');
  assert.equal(adminGroupFor('usr_oncall', allowlist), 'INTERNAL_OPS');
});

test('a bare allowlist entry never implicitly grants the stronger group', () => {
  assert.equal(adminGroupFor('usr_bare', allowlist), 'INTERNAL_OPS');
});

test('non-members and empty identities are refused', () => {
  assert.equal(adminGroupFor('usr_guest', allowlist), null);
  assert.equal(adminGroupFor(undefined, allowlist), null);
  assert.equal(adminGroupFor('', allowlist), null);
  // An empty allowlist must not turn into an open door.
  assert.equal(adminGroupFor('usr_ops', ''), null);
});

test('a substring of an allowlisted id is not a member', () => {
  assert.equal(adminGroupFor('usr_ops_evil', allowlist), null);
  assert.equal(adminGroupFor('xusr_ops', allowlist), null);
});

test('admin membership cannot be claimed by registering an email', () => {
  // auth.signup is public and performs no email verification, so an
  // attacker-chosen email must never resolve to a group.
  assert.equal(adminGroupFor('admin@bytspot.app', allowlist), null);
  assert.equal(
    adminGroupFor('admin@bytspot.app', 'admin@bytspot.app:BYTSPOT_ADMIN'),
    'BYTSPOT_ADMIN',
    'the parser is id-agnostic; safety comes from operators configuring ids, which the deploy check enforces',
  );
  assert.throws(
    () => assertBytspotAdmin({ userId: 'usr_attacker', email: 'admin@bytspot.app' }),
    { code: 'FORBIDDEN' },
    'an attacker who registers an admin-looking address gets no group',
  );
});

test('the gate separates unauthenticated from forbidden', () => {
  assert.throws(() => assertBytspotAdmin(null), { code: 'UNAUTHORIZED' });
  assert.throws(
    () => assertBytspotAdmin({ userId: 'usr_guest', email: 'guest@bytspot.com' }),
    { code: 'FORBIDDEN' },
  );
});

test('bootstrap resolution prints ids and a ready-to-paste allowlist', async () => {
  const out = await captureBootstrap('kojo@bytspot.com', [{ id: 'usr_kojo', email: 'kojo@bytspot.com' }]);
  assert.match(out, /kojo@bytspot\.com → usr_kojo/);
  assert.match(out, /ADMIN_USER_IDS=usr_kojo:BYTSPOT_ADMIN/);
});

test('bootstrap flags unregistered addresses as squattable', async () => {
  const out = await captureBootstrap('admin@bytspot.app', []);
  assert.match(out, /NOT REGISTERED/);
  assert.doesNotMatch(out, /ADMIN_USER_IDS=/);
});

test('bootstrap resolution grants nothing on its own', async () => {
  await captureBootstrap('kojo@bytspot.com', [{ id: 'usr_kojo', email: 'kojo@bytspot.com' }]);
  assert.equal(adminGroupFor('usr_kojo', ''), null);
  assert.throws(
    () => assertBytspotAdmin({ userId: 'usr_kojo', email: 'kojo@bytspot.com' }),
    { code: 'FORBIDDEN' },
  );
});

test('an empty bootstrap list prints nothing', async () => {
  assert.equal(await captureBootstrap('', []), '');
});

test('only the two documented groups exist', () => {
  assert.deepEqual([...ADMIN_GROUPS], ['BYTSPOT_ADMIN', 'INTERNAL_OPS']);
});

// ─── Admin Places and Vendors ────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const adminCaller = () => createCallerFactory(appRouter)({ user: { userId: 'usr_admin', email: 'ops@bytspot.com' }, clientRateLimitKey: 'test-admin' });
const guestCaller = () => createCallerFactory(appRouter)({ user: { userId: 'usr_guest', email: 'guest@bytspot.com' }, clientRateLimitKey: 'test-admin-guest' });

async function withAdmin<T>(run: () => Promise<T>): Promise<T> {
  const previous = config.adminUserIds;
  (config as any).adminUserIds = 'usr_admin:BYTSPOT_ADMIN';
  resetLocalRateLimitForTests();
  const quiet = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = quiet;
    (config as any).adminUserIds = previous;
  }
}

function stub(target: any, name: string, fn: unknown): () => void {
  const original = target[name];
  target[name] = fn;
  return () => { target[name] = original; };
}

test('only an admin reaches Admin Places and Vendors', async () => {
  await withAdmin(async () => {
    await assert.rejects(() => guestCaller().admin.places.list(), { code: 'FORBIDDEN' });
    await assert.rejects(() => guestCaller().admin.vendors.list(), { code: 'FORBIDDEN' });
    await assert.rejects(
      () => guestCaller().admin.places.save({ placeId: 'ChIJ_x', provider: 'resy', url: 'https://resy.com/x', category: 'restaurant' }),
      { code: 'FORBIDDEN' },
    );
    await assert.rejects(() => guestCaller().admin.vendors.approve({ sellerId: 'sel_1' }), { code: 'FORBIDDEN' });
  });
});

test('saving a place lists it with its link, and a foreign link is refused', async () => {
  await withAdmin(async () => {
    let created: any = null;
    let updated: any = null;
    const restores = [
      stub(db.venue, 'findUnique', async () => null),
      stub(db.venue, 'create', async ({ data }: any) => { created = data; return { id: 'ven_1', listedAt: data.listedAt }; }),
      stub(db.venue, 'update', async (args: any) => { updated = args; return { id: 'ven_1' }; }),
      stub(db.venue, 'findMany', async () => [{ googlePlaceId: 'ChIJ_new', bookingProvider: 'resy', bookingUrl: 'https://resy.com/cities/atl/new' }]),
      stub(db, '$executeRawUnsafe', async () => 1),
      stub(config, 'googlePlacesApiKey', 'test-key'),
      stub(globalThis, 'fetch', async () => new Response(JSON.stringify({
        id: 'ChIJ_new', displayName: { text: 'New Grill' }, formattedAddress: '1 Peachtree St NE, Atlanta, GA',
        location: { latitude: 33.78, longitude: -84.38 }, primaryType: 'restaurant',
      }), { status: 200 })),
    ];
    try {
      await assert.rejects(
        () => adminCaller().admin.places.save({ placeId: 'ChIJ_new', provider: 'resy', url: 'https://resy.com.evil.example/x', category: 'restaurant' }),
        { code: 'BAD_REQUEST' },
      );
      assert.equal(created as unknown, null);

      const saved = await adminCaller().admin.places.save({ placeId: 'ChIJ_new', provider: 'resy', url: 'https://resy.com/cities/atl/new', category: 'restaurant' });
      assert.equal(saved.venueId, 'ven_1');
      assert.equal(created.googlePlaceId, 'ChIJ_new');
      assert.equal(created.discoverable, true);
      assert.equal(created.bookingProvider, 'resy');
      assert.ok(created.bookingCheckedAt instanceof Date);
      assert.equal(created.listedByUserId, 'usr_admin');
      // A place listed before keeps the date it was first listed.
      assert.equal('listedAt' in updated.data, false);
      assert.equal(tableBookingLinkFor('ChIJ_new')?.label, 'Resy');
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('a place no one has listed cannot be hidden', async () => {
  await withAdmin(async () => {
    const restore = stub(db.venue, 'updateMany', async () => ({ count: 0 }));
    try {
      await assert.rejects(() => adminCaller().admin.places.setHidden({ venueId: 'ven_host', hidden: true }), { code: 'NOT_FOUND' });
    } finally {
      restore();
    }
  });
});

test('pitch numbers fold all-time and last-30-day counts per place', () => {
  const numbers = pitchNumbersFor(
    [{ id: 'ven_1', googlePlaceId: 'ChIJ_1' }, { id: 'ven_2', googlePlaceId: null }],
    {
      checkIns: [[{ key: 'ven_1', count: 9 }], [{ key: 'ven_1', count: 4 }]],
      bookingTaps: [[{ key: 'ven_1', count: 20 }, { key: 'ven_2', count: 1 }], []],
      planAdds: [[{ key: 'ChIJ_1', count: 3 }], [{ key: 'ChIJ_1', count: 3 }]],
      bookedByGuests: [[{ key: null, count: 5 }], []],
    },
  );
  assert.deepEqual(numbers.get('ven_1'), {
    checkIns: { total: 9, last30: 4 }, bookingTaps: { total: 20, last30: 0 },
    planAdds: { total: 3, last30: 3 }, bookedByGuests: { total: 0, last30: 0 },
  });
  assert.deepEqual(numbers.get('ven_2')?.planAdds, { total: 0, last30: 0 });
  assert.equal(numbers.get('ven_2')?.bookingTaps.total, 1);
});

test('a first guess at the category comes from Google, and the admin can change it', () => {
  assert.equal(categoryForPlaceType('italian_restaurant'), 'restaurant');
  assert.equal(categoryForPlaceType('wine_bar'), 'bar');
  assert.equal(categoryForPlaceType('night_club'), 'club');
  assert.equal(categoryForPlaceType('coffee_shop'), 'cafe');
  assert.equal(categoryForPlaceType(null), 'restaurant');
});

test('approving a finished business puts it live once, and records who approved it', async () => {
  await withAdmin(async () => {
    const finished = {
      id: 'sel_1', legalName: 'Midtown Table', contactEmail: 'owner@midtown.example', state: 'PENDING', businessMode: 'standard',
      payoutReference: 'acct_1', payoutStatus: 'active', approvedAt: null as Date | null, verifiedAt: null,
      locations: [{ id: 'loc_1', kind: 'fixed', state: 'ACTIVE', address: '1 Peachtree St NE', lat: 33.78, lng: -84.38 }],
    };
    const writes: any[] = [];
    const restores = [
      stub(db.vendorSeller, 'findUnique', async () => finished),
      stub(db.vendorSeller, 'updateMany', async (args: any) => { writes.push(args); return { count: 1 }; }),
      stub(db.vendorSeller, 'findUniqueOrThrow', async () => ({ ...finished, approvedAt: new Date() })),
      stub(db.vendorSeller, 'update', async ({ data }: any) => ({ ...finished, approvedAt: new Date(), ...data })),
    ];
    try {
      const result = await adminCaller().admin.vendors.approve({ sellerId: 'sel_1' });
      assert.deepEqual(result, { state: 'ACTIVE', live: true });
      assert.deepEqual(writes[0].where, { id: 'sel_1', approvedAt: null });
      assert.equal(writes[0].data.approvedByUserId, 'usr_admin');
    } finally {
      restores.reverse().forEach((restore) => restore());
    }
  });
});

test('the verified email links to the vendor console', () => {
  assert.equal(vendorConsoleOrigin(['https://bytspot.app', 'https://vendor.bytspot.app']), 'https://vendor.bytspot.app');
  assert.equal(vendorConsoleOrigin(['http://localhost:5173']), 'https://vendor.bytspot.app');
});
