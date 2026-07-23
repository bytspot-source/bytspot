import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicCaller } from '../__tests__/helpers';
import { db } from '../lib/db';
import { config } from '../config';

const venueRow = {
  id: 'v1', name: 'Test Bar', slug: 'test-bar', address: '123 Main St',
  lat: 33.78, lng: -84.38, category: 'bar', imageUrl: null,
  crowdLevels: [{ level: 2, label: 'Active', waitMins: 10, recordedAt: new Date('2026-07-23T12:00:00.000Z') }],
  parking: [{ name: 'Lot A', type: 'lot', available: 5, totalSpots: 20, pricePerHr: 5 }],
};

function mockVenueFeed() {
  (db.$queryRawUnsafe as any).mockResolvedValueOnce([]);
  (db.venue.findMany as any).mockResolvedValueOnce([venueRow]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  config.googlePlacesApiKey = '';
});

describe('native live adapter routes', () => {
  it('native.bootstrap returns backend-fed venues, cards, and events', async () => {
    mockVenueFeed();
    const caller = createPublicCaller();

    const result = await caller.native.bootstrap({ limit: 4 });

    expect(result.source).toBe('backend');
    expect(result.content.venues).toHaveLength(1);
    expect(result.content.discoverCards[0]).toMatchObject({ title: 'Test Bar', metadataLine: '5 arrival spots' });
    expect(result.content.events.length).toBeGreaterThan(0);
    expect((db.venue.findMany as any).mock.calls[0][0]).toMatchObject({ take: 4 });
  });

  it('live.bestValue ranks available parking from live venue inventory', async () => {
    mockVenueFeed();
    const caller = createPublicCaller();

    const result = await caller.live.bestValue({ lat: 33.7866, lng: -84.3833, durationHours: 2, limit: 2 });

    expect(result.source).toBe('backend');
    expect(result.options[0]).toMatchObject({
      productType: 'parking',
      title: 'Test Bar parking',
      providerName: 'Lot A',
      estimatedTotalCents: 1000,
      availability: '5 spots available',
    });
    expect(result.options[0].distanceMeters).toBeGreaterThan(0);
  });

  it('places.nearbySearch returns a 200-safe empty feed when Google quota fails', async () => {
    config.googlePlacesApiKey = 'test-google-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: vi.fn().mockResolvedValue('quota') }));
    const caller = createPublicCaller();

    const result = await caller.places.nearbySearch({ lat: 33.7866, lng: -84.3833, type: 'parking', maxResults: 8 });

    expect(result).toEqual({ places: [], source: 'google_error' });
  });

  it('places.textSearch returns a 200-safe empty feed when Google config fails', async () => {
    config.googlePlacesApiKey = 'test-google-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: vi.fn().mockResolvedValue('forbidden') }));
    const caller = createPublicCaller();

    const result = await caller.places.textSearch({ query: 'coffee', maxResults: 5 });

    expect(result).toEqual({ places: [], source: 'google_error' });
  });
});