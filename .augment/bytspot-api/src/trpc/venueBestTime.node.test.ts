import assert from 'node:assert/strict';
import test from 'node:test';

import { db } from '../lib/db';
import { appRouter } from './router';
import { createCallerFactory } from './trpc';

const caller = createCallerFactory(appRouter)({ user: null, clientRateLimitKey: 'best-time-test' });
const venue = db.venue as unknown as { findFirst: (args: unknown) => Promise<unknown> };
const crowdLevel = db.crowdLevel as unknown as { findMany: (args: unknown) => Promise<unknown[]> };
const prisma = db as unknown as {
  $queryRaw: (...args: unknown[]) => Promise<unknown[]>;
  mapReport: { findMany: (args: unknown) => Promise<unknown[]> };
};

const row = {
  id: 'venue-1', name: 'Stable Bar', slug: 'stable-bar-3', address: '1 Peachtree St',
  lat: 33.78, lng: -84.38, category: 'bar', imageUrl: null,
  photoProvenance: 'borrowed', photoAttribution: null,
  entryType: 'free', entryPrice: null, ticketUrl: null,
  discoverable: true, onlineOnly: false, crowdLevels: [], parking: [],
};

test('venues.bestTimeToGo returns a typical estimate, leave-by only with a known drive, and right now only when live', async () => {
  const originalFind = venue.findFirst;
  const originalQuery = prisma.$queryRaw;
  const originalReports = prisma.mapReport.findMany;
  venue.findFirst = async () => ({ id: row.id, slug: row.slug, category: row.category });
  prisma.mapReport.findMany = async () => [];
  prisma.$queryRaw = async () => [];
  try {
    const estimate = await caller.venues.bestTimeToGo({
      slug: 'stable-bar-3',
      startsAt: '2026-11-06T16:00:00-05:00',
      endsAt: '2026-11-06T23:00:00-05:00',
      slotMinutes: 30,
      originLat: 33.77,
      originLng: -84.39,
    });
    assert.equal(estimate.source, 'typical');
    assert.equal(estimate.summary, 'Typically quieter before 5:00 PM (estimate)');
    assert.equal(estimate.driveMinutes, null);
    assert.equal(estimate.preferredLeaveBy, null);
    assert.equal(estimate.rightNow, null);
    assert.equal('leaveBy' in estimate.slots[0], false);
    assert.equal(estimate.slots[0].level, 1);
    assert.equal(estimate.slots[0].label, 'Chill');

    const driven = await caller.venues.bestTimeToGo({
      slug: 'stable-bar-3',
      startsAt: '2026-11-06T21:00:00-05:00',
      endsAt: '2026-11-06T21:30:00-05:00',
      slotMinutes: 30,
      driveMinutes: 25,
    });
    assert.equal(driven.slots[0].arrivalAt, '2026-11-06T21:00:00-05:00');
    assert.equal(driven.slots[0].leaveBy, '2026-11-06T20:35:00-05:00');
    assert.equal(driven.preferredLeaveBy, '2026-11-06T20:35:00-05:00');

    prisma.$queryRaw = async () => [{
      id: 'live-1', venueId: row.id, level: 4, label: 'Packed', waitMins: null,
      source: 'user_report', recordedAt: new Date(),
    }];
    const live = await caller.venues.bestTimeToGo({
      slug: 'stable-bar-3',
      startsAt: '2026-11-06T16:00:00-05:00',
      endsAt: '2026-11-06T23:00:00-05:00',
      slotMinutes: 30,
    });
    assert.equal(live.summary, estimate.summary);
    assert.equal(live.rightNow?.line, "Right now it's packed.");
    assert.equal(live.rightNow?.source, 'user_report');
    assert.doesNotMatch(live.summary, /right now|empty/i);
  } finally {
    venue.findFirst = originalFind;
    prisma.$queryRaw = originalQuery;
    prisma.mapReport.findMany = originalReports;
  }
});

test('venues.bestTimeToGo is missing for an unknown slug and rejects an inverted window', async () => {
  const originalFind = venue.findFirst;
  venue.findFirst = async () => null;
  try {
    await assert.rejects(() => caller.venues.bestTimeToGo({ slug: 'missing-bar' }), { code: 'NOT_FOUND' });
    await assert.rejects(() => caller.venues.bestTimeToGo({
      slug: 'stable-bar-3',
      startsAt: '2026-11-06T23:00:00-05:00',
      endsAt: '2026-11-06T16:00:00-05:00',
    }), { code: 'BAD_REQUEST' });
  } finally {
    venue.findFirst = originalFind;
  }
});

test('venues.getBySlug includes the same typical estimate', async () => {
  const originalFind = venue.findFirst;
  const originalCrowd = crowdLevel.findMany;
  const originalReports = prisma.mapReport.findMany;
  venue.findFirst = async () => row;
  crowdLevel.findMany = async () => [];
  prisma.mapReport.findMany = async () => [];
  try {
    const detail = await caller.venues.getBySlug({ slug: 'stable-bar-3' });
    assert.equal(detail.bestTimeToGo.source, 'typical');
    assert.equal(detail.bestTimeToGo.slotMinutes, 30);
    assert.equal(detail.bestTimeToGo.driveMinutes, null);
    assert.match(detail.bestTimeToGo.summary, /^Typically .+ \(estimate\)$/);
    assert.doesNotMatch(detail.bestTimeToGo.summary, /right now|empty|live/i);
    assert.ok(detail.bestTimeToGo.slots.length > 0);
    assert.equal(detail.bestTimeToGo.rightNow, null);
  } finally {
    venue.findFirst = originalFind;
    crowdLevel.findMany = originalCrowd;
    prisma.mapReport.findMany = originalReports;
  }
});
