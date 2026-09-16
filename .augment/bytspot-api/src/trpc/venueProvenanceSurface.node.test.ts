import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

/**
 * A photograph is an endorsement, and the native detail hero fails closed on
 * provenance. Every venue read the app uses to build a place must therefore
 * carry it, or an owned photograph silently reads as borrowed and no hero
 * ever fills.
 */

const createCaller = createCallerFactory(appRouter);
const anonymous: Context = { user: null, clientRateLimitKey: 'venue-provenance-test' };
const venue = db.venue as any;
const prisma = db as any;

const row = {
  id: 'venue-1', name: 'Broni', slug: 'broni', address: '1 Peachtree St',
  lat: 33.78, lng: -84.38, category: 'dining', imageUrl: 'https://cdn.bytspot.com/broni.jpg',
  photoProvenance: 'bytspot_owned', photoAttribution: null,
  entryType: 'free', entryPrice: null, ticketUrl: null,
  discoverable: true, crowdLevels: [], parking: [],
};

beforeEach(() => {
  venue.findMany = async () => [row];
  venue.findFirst = async () => row;
  prisma.$queryRawUnsafe = async () => [{
    id: row.id, name: row.name, slug: row.slug, address: row.address,
    lat: row.lat, lng: row.lng, category: row.category, image_url: row.imageUrl,
    photo_provenance: 'bytspot_owned', photo_attribution: null, distance: 120,
  }];
});

test('Every venue read the native client uses carries photo provenance', async () => {
  const caller = createCaller(anonymous);

  const list = (await caller.venues.list()).venues[0] as any;
  assert.equal(list.photoProvenance, 'bytspot_owned');
  assert.equal(list.pinPhotoUrl, row.imageUrl);

  const nearby = (await caller.venues.nearby({ lat: 33.78, lng: -84.38 })).venues[0] as any;
  assert.equal(nearby.photoProvenance, 'bytspot_owned');

  const bySlug = await caller.venues.getBySlug({ slug: 'broni' }) as any;
  assert.equal(bySlug.photoProvenance, 'bytspot_owned');
});

test('Borrowed and unrecognised provenance never earn a pin photo', async () => {
  const caller = createCaller(anonymous);

  for (const raw of ['borrowed', 'google', '', null, undefined]) {
    venue.findMany = async () => [{ ...row, photoProvenance: raw }];
    const listed = (await caller.venues.list()).venues[0] as any;
    assert.equal(listed.photoProvenance, 'borrowed');
    assert.equal(listed.pinPhotoUrl, null);
    // The photograph itself still travels for routing-only surfaces.
    assert.equal(listed.imageUrl, row.imageUrl);
  }
});
