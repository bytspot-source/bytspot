/**
 * SAMPLE FIXTURE DATA — FOR TESTS ONLY.
 *
 * Every venue, event, price, link and person below is fictional and prefixed
 * "SAMPLE". None of it may ship to guests or be used as real supply. Real data
 * comes only from production ports wired to bytspot-api.
 */
import type { BookableRecord, EventRecord, PersonRecord, PlaceRecord } from '../ports/types';

export const SAMPLE_FRIDAY = { startsAt: '2026-11-06T19:00:00-05:00', endsAt: '2026-11-06T23:30:00-05:00' } as const;

export const SAMPLE_PLACES: Array<PlaceRecord & { needKinds: string[] }> = [
  { placeId: 'SAMPLE_dinner_southern', name: 'SAMPLE Southern Kitchen', address: 'SAMPLE 1 Peachtree St NE, Atlanta, GA', latitude: 33.7845, longitude: -84.3838, types: ['restaurant'], rating: 4.5, isOpen: true, priceCents: 3400, priceBasis: 'estimate', crowd: { level: 3, source: 'typical' }, needKinds: ['dining'] },
  { placeId: 'SAMPLE_dinner_taqueria', name: 'SAMPLE Taqueria Midtown', address: 'SAMPLE 2 10th St NE, Atlanta, GA', latitude: 33.7812, longitude: -84.3850, types: ['restaurant'], rating: 4.3, isOpen: true, priceCents: 2200, priceBasis: 'estimate', crowd: null, needKinds: ['dining'] },
  { placeId: 'SAMPLE_dinner_steak', name: 'SAMPLE Prime Steakhouse', address: 'SAMPLE 3 14th St NW, Atlanta, GA', latitude: 33.7860, longitude: -84.3880, types: ['restaurant'], rating: 4.7, isOpen: true, priceCents: 9500, priceBasis: 'estimate', crowd: { level: 2, source: 'typical' }, needKinds: ['dining'] },
  { placeId: 'SAMPLE_bar_rooftop', name: 'SAMPLE Rooftop Lounge', address: 'SAMPLE 4 Peachtree St NE, Atlanta, GA', latitude: 33.7850, longitude: -84.3832, types: ['bar'], rating: 4.2, isOpen: true, priceCents: 2000, priceBasis: 'estimate', crowd: { level: 4, source: 'typical' }, needKinds: ['drinks', 'nightlife'] },
  { placeId: 'SAMPLE_bar_speakeasy', name: 'SAMPLE Speakeasy 10th', address: 'SAMPLE 5 10th St NE, Atlanta, GA', latitude: 33.7818, longitude: -84.3825, types: ['bar'], rating: 4.6, isOpen: true, priceCents: 2400, priceBasis: 'provider_listed', crowd: { level: 2, source: 'sensor', observedAt: '2026-11-06T21:00:00-05:00' }, needKinds: ['drinks', 'nightlife'] },
  { placeId: 'SAMPLE_bar_champagne', name: 'SAMPLE Champagne Bar', address: 'SAMPLE 6 Crescent Ave NE, Atlanta, GA', latitude: 33.7865, longitude: -84.3842, types: ['bar'], rating: 4.4, isOpen: true, priceCents: 7000, priceBasis: 'estimate', crowd: null, needKinds: ['drinks'] },
  { placeId: 'SAMPLE_far_bar', name: 'SAMPLE Far Away Bar', address: 'SAMPLE Decatur, GA', latitude: 33.7748, longitude: -84.2963, types: ['bar'], rating: 4.0, isOpen: true, priceCents: 1500, priceBasis: 'estimate', crowd: null, needKinds: ['drinks'] },
];

export const SAMPLE_EVENTS: EventRecord[] = [
  { id: 'SAMPLE_event_jazz', title: 'SAMPLE Late Jazz Set', venueName: 'SAMPLE Speakeasy 10th', placeId: 'SAMPLE_bar_speakeasy', address: 'SAMPLE 5 10th St NE, Atlanta, GA', latitude: 33.7818, longitude: -84.3825, startsAt: '2026-11-06T22:00:00-05:00', endsAt: '2026-11-06T23:30:00-05:00', priceCents: null, capacity: 40, bookableId: 'party:SAMPLE_event_jazz', capability: 'book' },
];

export const SAMPLE_BOOKABLES: Record<string, { bookables: BookableRecord[]; tableLink: { provider: 'opentable' | 'resy'; label: string; url: string } | null }> = {
  SAMPLE_dinner_southern: { bookables: [], tableLink: { provider: 'opentable', label: 'OpenTable', url: 'https://www.opentable.com/r/sample-southern-kitchen' } },
  SAMPLE_dinner_taqueria: { bookables: [], tableLink: { provider: 'resy', label: 'Resy', url: 'https://resy.com/cities/atl/sample-taqueria' } },
  SAMPLE_dinner_steak: { bookables: [], tableLink: { provider: 'opentable', label: 'OpenTable', url: 'https://evil.example.com/not-opentable' } },
  SAMPLE_bar_speakeasy: { bookables: [
    { id: 'BYT-SAMPLE-BOOTH-1', sourceKind: 'offer', capability: 'book', provider: null, tierName: 'SAMPLE Reserved booth', priceCents: 2400, capacity: 6 },
    { id: 'BYT-SAMPLE-DETAILS-1', sourceKind: 'place', capability: 'details', provider: null, tierName: 'SAMPLE reference only', priceCents: 0, capacity: 0 },
  ], tableLink: null },
};

export const SAMPLE_PEOPLE: Record<string, PersonRecord[]> = {
  'SAMPLE_user_1': [
    { userId: 'SAMPLE_user_2', displayName: 'SAMPLE Ama', preferences: ['vegetarian'] },
    { userId: 'SAMPLE_user_3', displayName: 'SAMPLE Kofi', preferences: ['no shellfish'] },
    { userId: 'SAMPLE_user_4', displayName: 'SAMPLE Esi', preferences: [] },
  ],
};
