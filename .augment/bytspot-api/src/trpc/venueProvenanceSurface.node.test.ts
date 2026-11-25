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
  prisma.$queryRaw = async () => [];
  (db.crowdLevel as any).findMany = async () => [];
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

test('Every venue read says whether it is Bytspot-controlled, and defaults to listed', async () => {
  const caller = createCaller(anonymous);

  assert.equal(((await caller.venues.list()).venues[0] as any).control, 'listed');
  assert.equal(((await caller.venues.nearby({ lat: 33.78, lng: -84.38 })).venues[0] as any).control, 'listed');
  assert.equal(((await caller.venues.getBySlug({ slug: 'broni' })) as any).control, 'listed');

  const approved = new Date('2026-10-01T12:00:00Z');
  venue.findMany = async () => [{ ...row, controlledAt: approved }];
  venue.findFirst = async () => ({ ...row, controlledAt: approved });
  prisma.$queryRawUnsafe = async () => [{
    id: row.id, name: row.name, slug: row.slug, address: row.address,
    lat: row.lat, lng: row.lng, category: row.category, image_url: row.imageUrl,
    photo_provenance: 'bytspot_owned', photo_attribution: null, controlled_at: approved, distance: 120,
  }];
  assert.equal(((await caller.venues.list({ entryType: 'free' })).venues[0] as any).control, 'bytspot');
  assert.equal(((await caller.venues.nearby({ lat: 33.79, lng: -84.38 })).venues[0] as any).control, 'bytspot');
  assert.equal(((await caller.venues.getBySlug({ slug: 'broni-approved' })) as any).control, 'bytspot');
});

test('A Bytspot-controlled venue shows its curated cover, gallery and video; a listed one never does', async () => {
  const caller = createCaller(anonymous);
  const media = [
    { id: 'vm_video', kind: 'video', position: 0 },
    { id: 'vm_g1', kind: 'gallery', position: 1 },
    { id: 'vm_g0', kind: 'gallery', position: 0 },
    { id: 'vm_cover', kind: 'cover', position: 0 },
  ];
  venue.findMany = async () => [{ ...row, photoProvenance: 'borrowed', controlledAt: new Date('2026-10-01T12:00:00Z'), media }];
  const curated = (await caller.venues.list({ entryType: 'paid' })).venues[0] as any;
  assert.match(curated.imageUrl, /\/media\/venue\/vm_cover$/);
  assert.equal(curated.photoProvenance, 'bytspot_owned');
  assert.equal(curated.mapPresentation, 'pin');
  assert.deepEqual(curated.photoUrls.map((u: string) => u.split('/').pop()), ['vm_cover', 'vm_g0', 'vm_g1']);
  assert.match(curated.vibeVideoUrl, /\/media\/venue\/vm_video$/);

  venue.findMany = async () => [{ ...row, controlledAt: null, media }];
  const listed = (await caller.venues.list({ entryType: 'free' })).venues[0] as any;
  assert.equal(listed.imageUrl, row.imageUrl);
  assert.equal(listed.photoUrls, undefined);
  assert.equal(listed.vibeVideoUrl, undefined);

  // A video alone is not a cover.
  venue.findMany = async () => [{ ...row, controlledAt: new Date('2026-10-01T12:00:00Z'), media: [media[0]] }];
  assert.equal(((await caller.venues.list()).venues[0] as any).vibeVideoUrl, undefined);
});

test('Online businesses are only listed for clients that ask, and never show their registered address', async () => {
  const caller = createCaller(anonymous);
  const online = { ...row, id: 'venue-online', slug: 'buzz', onlineOnly: true, website: 'https://trybuzzcall.com/', address: '8735 Dunwoody Pl #13893' };
  const wheres: any[] = [];
  venue.findMany = async (args: any) => { wheres.push(args.where); return args.where.onlineOnly === false ? [row] : [row, online]; };
  venue.findFirst = async () => online;

  await caller.venues.list();
  assert.equal(wheres.at(-1).onlineOnly, false, 'an older client that pins every row never receives one');

  const all = (await caller.venues.list({ includeOnline: true })).venues as any[];
  const listed = all.find((v) => v.id === 'venue-online');
  assert.equal(listed.online, true);
  assert.equal(listed.website, 'https://trybuzzcall.com/');
  assert.equal(listed.address, 'Online business');

  const bySlug = await caller.venues.getBySlug({ slug: 'buzz' }) as any;
  assert.equal(bySlug.online, true);
  assert.equal(bySlug.address, 'Online business');
});

test('Check-in is refused at an online business, before anything is written', async () => {
  const caller = createCaller({ user: { userId: 'usr_guest', email: 'guest@example.test' }, clientRateLimitKey: 'venue-online-checkin' } as Context);
  venue.findUnique = async () => ({ ...row, onlineOnly: true });
  prisma.$transaction = async () => assert.fail('nothing should be written');
  await assert.rejects(() => caller.venues.checkin({ venueId: 'venue-online' }), { code: 'BAD_REQUEST' });
});
