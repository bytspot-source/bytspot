import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { dishText, findMenuEvidence, matchesMenuDish, MENU_REVIEW_MS, menuQueryTerms, menuSearchBounds,
  menuTransaction, reviewMenuDish, submitMenuDishSchema } from './menuEvidence';

const restores: Array<() => void> = [];
function stubDb(name: '$queryRaw' | '$transaction', implementation: (...args: any[]) => any) {
  const original = db[name];
  const fn = mock.fn(implementation);
  (db as any)[name] = fn;
  restores.push(() => { (db as any)[name] = original; });
  return fn;
}
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); mock.restoreAll(); });
const now = new Date('2026-10-17T12:00:00.000Z');
const search = { query: 'jollof rice', mode: 'category' as const, location: { lat: 33.78, lng: -84.38 }, radius: 2000 };
function evidenceRow(extra: Record<string, unknown> = {}) {
  return { id: 'venue', slug: 'kitchen', name: 'Kitchen', address: '1 Example Street', lat: 33.78, lng: -84.38,
    category: 'restaurant', imageUrl: null, googlePlaceId: null, dishId: 'dish', dishName: 'Jollof rice',
    aliases: [], mediaId: 'menu', reviewedAt: now, updatedAt: now, ...extra };
}

test('only complete literal tokens in one reviewed name/alias match; no inferred claims', () => {
  assert.equal(matchesMenuDish('rice', 'Jollof rice', []), true);
  assert.equal(matchesMenuDish('rice', 'Priceless pie', []), false);
  assert.equal(matchesMenuDish('jollof rice', 'Jollof', ['Rice']), false);
  assert.equal(matchesMenuDish('jollof rice', 'House special', ['Jollof rice']), true);
  assert.equal(matchesMenuDish('JOLLOF RICE', 'Jollof-rice', []), true);
  assert.equal(matchesMenuDish('ramen', 'Japanese kitchen', []), false);
  assert.equal(matchesMenuDish('chicken rice', 'Chicken soup with rice noodles', []), false);
  assert.equal(matchesMenuDish('chicken rice', 'Rice chicken', []), false);
  assert.equal(matchesMenuDish('chicken rice', 'House special', ['Spicy chicken, rice bowl']), true);
  assert.equal(matchesMenuDish('rice rice', 'Rice', []), false);
  assert.equal(matchesMenuDish('rice rice', 'Rice-rice bowl', []), true);
  for (const query of ['restaurant', 'restaurants', 'coffee', 'places', 'best rice', 'vegan rice', 'gluten free rice', 'healthy rice', 'top rated rice']) {
    assert.deepEqual(menuQueryTerms(query), [], query);
    assert.equal(matchesMenuDish(query, query, [query]), false);
  }
});

test('strict submissions reject approval, venue identity, malformed names and missing update versions', () => {
  const body = { mediaId: 'media', dishName: 'Jollof rice' };
  assert.equal(submitMenuDishSchema.safeParse(body).success, true);
  assert.equal(dishText.safeParse('House bowl: Jollof rice').success, true);
  for (const extra of [{ venueId: 'venue' }, { reviewStatus: 'approved' }, { dishId: 'dish' }, { expectedUpdatedAt: now.toISOString() }]) {
    assert.equal(submitMenuDishSchema.safeParse({ ...body, ...extra }).success, false);
  }
  assert.equal(submitMenuDishSchema.safeParse({ ...body, dishId: 'dish', expectedUpdatedAt: now.toISOString() }).success, true);
  assert.equal(submitMenuDishSchema.safeParse({ ...body, aliases: Array(6).fill('rice') }).success, false);
  for (const text of ['', ' ', 'x'.repeat(121), 'rice\n', 'rice\u0000', '\u200brice', '<b>Rice</b>', 'https://example.test', 'www.example.test', 'example.com', 'example.com?menu', 'example.com#menu', 'x@example.test', '+1 404 555 1234']) {
    assert.equal(dishText.safeParse(text).success, false, JSON.stringify(text));
  }
});

test('name mode, generic/claim queries and invalid coordinates do not access the database', async () => {
  const query = stubDb('$queryRaw', async () => { throw new Error('must not read'); });
  for (const input of [{ ...search, mode: 'name' as const }, { ...search, query: 'coffee' }, { ...search, query: 'best rice' },
    { ...search, location: { lat: 0, lng: 0 } }, { ...search, location: { lat: NaN, lng: 0 } }, { ...search, radius: Infinity }, { ...search, radius: 5001 }]) {
    assert.deepEqual(await findMenuEvidence(input, now), []);
  }
  assert.equal(query.mock.callCount(), 0);
});

test('parameterized bounded query rechecks source revision, binding, tenant, visibility and uploaded content before LIMIT', async () => {
  stubDb('$queryRaw', async (statement: any) => {
    const sql = statement.sql as string;
    for (const clause of ["d.review_status = 'approved'", 'd.source_updated_at = m.updated_at', 'd.reviewed_venue_id = l.menu_venue_id',
      "l.state = 'ACTIVE'", "s.state = 'ACTIVE'", 'v.discoverable', 'm.seller_id = l.seller_id', 'm.location_id = l.id',
      'm.bookable_id IS NULL', "m.kind = 'menu'", "m.review_status = 'approved'", 'octet_length(m.bytes)',
      'd.reviewed_at >', 'd.reviewed_at <=', 'regexp_replace', 'strpos(', 'LIMIT 200',
      'dense_rank() OVER (ORDER BY distance ASC, id ASC)', 'row_number() OVER (PARTITION BY id ORDER BY',
      'venue_rank <= 20 AND dish_rank <= 3', 'm.mime_type IN']) assert.ok(sql.includes(clause), clause);
    assert.ok(sql.indexOf('regexp_replace') < sql.indexOf('LIMIT 200'));
    assert.ok(sql.indexOf('venue_rank <= 20 AND dish_rank <= 3') < sql.indexOf('LIMIT 200'));
    assert.ok(statement.values.includes(' jollof rice '));
    assert.equal(sql.includes('<@'), false);
    assert.equal(sql.includes('jollof'), false);
    assert.equal(sql.includes('contact_email'), false);
    return [evidenceRow()];
  });
  const result = await findMenuEvidence(search, now);
  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0].evidence).sort(), ['dishId', 'revision', 'dishName', 'expiresAt', 'mediaId', 'retrievedAt', 'reviewedAt', 'source', 'sourceUrl'].sort());
  assert.equal(result[0].evidence.source, 'vendor_menu');
  assert.equal(result[0].evidence.expiresAt, new Date(now.getTime() + MENU_REVIEW_MS).toISOString());
  assert.equal(result[0].evidence.dishId, 'dish');
  assert.equal(result[0].evidence.revision, String(now.getTime()));
  assert.ok(result[0].evidence.sourceUrl.endsWith(`/media/menu-evidence/dish/${now.getTime()}`));
  assert.equal('aliases' in result[0].evidence, false);
  assert.equal('mediaId' in result[0].venue, false);
});

test('SQL binds one normalized contiguous phrase, including punctuation and repeated tokens', async () => {
  const phrases: string[] = [];
  stubDb('$queryRaw', async (statement: any) => {
    const phrase = statement.values.find((value: unknown) => typeof value === 'string' && value.startsWith(' ') && value.endsWith(' '));
    phrases.push(phrase); return [];
  });
  for (const query of ['CHICKEN---rice', 'rice rice', '  chicken, rice  ']) await findMenuEvidence({ ...search, query, radius: 5000 }, now);
  assert.deepEqual(phrases, [' chicken rice ', ' rice rice ', ' chicken rice ']);
});

test('freshness, full-token matching, real coordinates, food rail and spherical distance fail closed', async () => {
  for (const extra of [{ reviewedAt: new Date(now.getTime() - MENU_REVIEW_MS) }, { reviewedAt: new Date(now.getTime() + 1) },
    { dishName: 'Rice pudding' }, { lat: 0, lng: 0 }, { lat: NaN }, { lat: 34.78 }, { category: 'bar' },
    { dishName: 'Jollof rice contact@example.test' }]) {
    stubDb('$queryRaw', async () => [evidenceRow(extra)]);
    assert.deepEqual(await findMenuEvidence(search, now), [], JSON.stringify(extra));
  }
});

test('results are deterministic, deduplicated, capped to three dishes and twenty venues', async () => {
  const rows = Array.from({ length: 25 }, (_, v) => Array.from({ length: 5 }, (_, d) => evidenceRow({
    id: `venue-${String(v).padStart(2, '0')}`, dishId: `dish-${d}`, dishName: `Jollof rice ${d}`,
  }))).flat();
  rows.push({ ...rows[0], dishId: 'duplicate' });
  stubDb('$queryRaw', async () => rows.slice().reverse());
  const result = await findMenuEvidence(search, now);
  assert.equal(result.length, 60);
  assert.equal(new Set(result.map((row) => row.venue.id)).size, 20);
  assert.equal(new Set(result.map((row) => `${row.venue.id}:${row.evidence.dishName}`)).size, 60);
  assert.deepEqual(result.slice(0, 3).map((row) => row.evidence.dishName), ['Jollof rice 0', 'Jollof rice 1', 'Jollof rice 2']);
});

test('distance excludes bounding-box corners and accepts nearby venues across the date line', async () => {
  let rows = [evidenceRow({ lat: 33.79, lng: -84.36 })];
  stubDb('$queryRaw', async () => rows);
  assert.deepEqual(await findMenuEvidence(search, now), []);
  rows = [evidenceRow({ lat: 0, lng: -179.999, reviewedAt: new Date(now.getTime() - MENU_REVIEW_MS + 1) })];
  const result = await findMenuEvidence({ ...search, location: { lat: 0, lng: 179.999 } }, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].evidence.expiresAt, new Date(now.getTime() + 1).toISOString());
});

test('bounds cross the date line and include all longitudes near a pole', () => {
  const crossing = menuSearchBounds({ lat: 0, lng: 179.999 }, 2000);
  assert.ok(crossing.lowLng > crossing.highLng);
  const polar = menuSearchBounds({ lat: 89.999, lng: 40 }, 2000);
  assert.deepEqual([polar.lowLng, polar.highLng, polar.highLat], [-180, 180, 90]);
});

test('review checks all explicit versions and rejects pending/empty/cross-tenant sources', async () => {
  const base: any = { id: 'dish', locationId: 'location', updatedAt: now,
    media: { id: 'menu', locationId: 'location', sellerId: 'seller', bookableId: null, kind: 'menu', updatedAt: now,
      reviewStatus: 'approved', bytes: Buffer.from('menu'), byteSize: 4, storageKey: null },
    location: { menuVenueId: 'venue', sellerId: 'seller', state: 'ACTIVE', seller: { state: 'ACTIVE' }, menuVenue: { discoverable: true } } };
  const input = { dishId: 'dish', approve: true, expectedUpdatedAt: now.toISOString(), expectedMediaUpdatedAt: now.toISOString(), expectedVenueId: 'venue' };
  let row = base;
  let writes = 0;
  stubDb('$transaction', async (run: any, options: any) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return run({ vendorMenuDish: { findUnique: async () => row, updateMany: async ({ data, where }: any) => {
      writes++; assert.equal(data.sourceUpdatedAt, now); assert.equal(data.reviewedVenueId, 'venue');
      assert.equal(data.reviewedByUserId, 'admin'); assert.equal(where.location.menuVenueId, 'venue'); return { count: 1 };
    } } });
  });
  for (const bad of [{ ...input, expectedUpdatedAt: new Date(0).toISOString() }, { ...input, expectedMediaUpdatedAt: new Date(0).toISOString() },
    { ...input, expectedVenueId: null }]) await assert.rejects(() => reviewMenuDish(bad, 'admin', now), { status: 409 });
  for (const change of [{ reviewStatus: 'pending' }, { bytes: Buffer.alloc(0), byteSize: 0 }, { sellerId: 'other' }, { bookableId: 'window' }, { locationId: 'other' }]) {
    row = { ...base, media: { ...base.media, ...change } };
    await assert.rejects(() => reviewMenuDish(input, 'admin', now), { status: 409 });
  }
  assert.equal(writes, 0);
  row = base;
  await reviewMenuDish(input, 'admin', now);
  await reviewMenuDish(input, 'admin', now); // Reapproval does not require pending status.
  assert.equal(writes, 2);
});

test('serialization conflicts are explicit, never retried using stale versions', async () => {
  const txn = stubDb('$transaction', async () => {
    throw new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' });
  });
  await assert.rejects(() => menuTransaction(async () => null), { status: 409 });
  assert.equal(txn.mock.callCount(), 1);
});
