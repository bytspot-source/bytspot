import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const createCaller = createCallerFactory(appRouter);
const platinumContext: Context = { user: { userId: 'platinum-user', email: 'platinum@bytspot.com' } };
const quoteId = 'quote-1';
const idempotencyKey = '00000000-0000-4000-8000-000000000099';
const now = new Date('2026-08-12T18:00:00.000Z');
const user = db.user as any;
const venue = db.venue as any;
const mobilityQuote = db.mobilityQuote as any;
const mobilityTrip = db.mobilityTrip as any;

function caller(context = platinumContext) {
  return createCaller(context);
}

beforeEach(() => {
  user.findUnique = async () => ({ membershipTier: 'platinum' });
  venue.findUnique = async () => ({ id: 'venue-1', name: 'Private Venue', address: '1 Safe Street', lat: 33.749, lng: -84.388 });
  mobilityQuote.create = async ({ data }: any) => ({
    id: quoteId, providerQuoteId: null, priceLabel: null, etaLabel: null, createdAt: now, updatedAt: now,
    ...data, venue: { lat: 33.749, lng: -84.388, name: 'Private Venue', address: '1 Safe Street' },
  });
  mobilityQuote.findFirst = async () => ({
    id: quoteId, userId: 'platinum-user', providerQuoteId: null, provider: 'handoff', serviceClass: 'premium',
    serviceTitle: 'Premium ride handoff', priceLabel: null, etaLabel: null, pickupLabel: 'Current location',
    dropoffLabel: '1 Safe Street', bookingMode: 'handoff', status: 'ready', expiresAt: new Date(Date.now() + 60_000),
    venue: { lat: 33.749, lng: -84.388, name: 'Private Venue', address: '1 Safe Street' },
  });
  mobilityTrip.findUnique = async () => null;
  mobilityTrip.findFirst = async () => null;
  mobilityTrip.create = async ({ data }: any) => ({
    id: 'trip-1', providerReservationId: null, createdAt: now, updatedAt: now, ...data,
    quote: { serviceClass: 'premium', serviceTitle: 'Premium ride handoff', priceLabel: null, etaLabel: null, pickupLabel: 'Current location', dropoffLabel: '1 Safe Street' },
  });
  mobilityTrip.updateMany = async () => ({ count: 1 });
});

test('Green users cannot create a premium mobility handoff quote', async () => {
  user.findUnique = async () => ({ membershipTier: 'green' });
  await assert.rejects(
    () => caller().mobility.quotes.create({ venueId: 'venue-1', pickupLocation: { lat: 33.78, lng: -84.38 } }),
    { code: 'FORBIDDEN' },
  );
});

test('Platinum quote resolves its destination from the server-owned venue', async () => {
  let created: any;
  mobilityQuote.create = async ({ data }: any) => {
    created = data;
    return { id: quoteId, providerQuoteId: null, priceLabel: null, etaLabel: null, createdAt: now, updatedAt: now, ...data, venue: { lat: 33.749, lng: -84.388, name: 'Private Venue', address: '1 Safe Street' } };
  };

  const result = await caller().mobility.quotes.create({
    venueId: 'venue-1', pickupLocation: { lat: 33.78, lng: -84.38 }, pickupLabel: 'Current location',
  });

  assert.equal(created.venueId, 'venue-1');
  assert.equal(created.dropoffLabel, '1 Safe Street');
  assert.equal(result.providerBookingMode, 'handoff');
  assert.equal(result.aggregatorReadiness, 'handoff');
  const uber = new URL(result.handoffOptions.find((option) => option.provider === 'uber')!.url);
  const lyft = new URL(result.handoffOptions.find((option) => option.provider === 'lyft')!.url);
  assert.equal(uber.host, 'm.uber.com');
  assert.equal(uber.pathname, '/ul/');
  assert.equal(uber.searchParams.get('dropoff[latitude]'), '33.749');
  assert.equal(uber.searchParams.get('dropoff[nickname]'), 'Private Venue');
  assert.equal(uber.searchParams.get('dropoff[formatted_address]'), '1 Safe Street');
  assert.equal(lyft.host, 'ride.lyft.com');
  assert.equal(lyft.pathname, '/u');
  assert.equal(lyft.searchParams.get('id'), 'lyft');
  assert.equal(lyft.searchParams.get('destination[latitude]'), '33.749');
  assert.equal(lyft.searchParams.get('destination[longitude]'), '-84.388');
});

test('Black members receive an idempotent HTTPS Uber handoff, not a Bytspot booking', async () => {
  user.findUnique = async () => ({ membershipTier: 'black' });
  const result = await caller().mobility.reservations.create({ quoteId, provider: 'uber', idempotencyKey });

  assert.equal(result.status, 'handoff_pending');
  assert.equal(result.providerReservationId, null);
  const handoff = new URL(result.handoffUrl ?? '');
  assert.equal(handoff.host, 'm.uber.com');
  assert.equal(handoff.searchParams.get('dropoff[latitude]'), '33.749');
  assert.equal(handoff.searchParams.get('dropoff[nickname]'), 'Private Venue');
  assert.equal(result.trackingUrl, null);
  assert.equal(result.trackingMode, 'handoff-only');
});

test('Cancelling a handoff only updates Bytspot tracking and does not imply provider cancellation', async () => {
  const result = await caller().mobility.reservations.cancel({ id: 'trip-1', reason: 'Changed plans' });
  assert.equal(result.ok, true);
  assert.equal(result.cancellationMode, 'handoff-only');
});

test('Trip status is a POST-compatible mutation scoped to the authenticated rider', async () => {
  mobilityTrip.findFirst = async () => ({
    id: 'trip-1', quoteId, provider: 'lyft', providerReservationId: null, handoffUrl: 'https://www.lyft.com/rider',
    status: 'handoff_pending', createdAt: now, updatedAt: now,
    quote: { serviceClass: 'premium', serviceTitle: 'Premium ride handoff', priceLabel: null, etaLabel: null, pickupLabel: 'Current location', dropoffLabel: '1 Safe Street' },
  });
  const result = await caller().mobility.trips.status({ id: 'trip-1' });
  assert.equal(result.provider, 'lyft');
  assert.equal(result.status, 'handoff_pending');
});