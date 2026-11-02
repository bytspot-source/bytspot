/**
 * In-memory fake ports over SAMPLE fixture data. FOR TESTS ONLY.
 * `down` options simulate a provider outage (throw) for honesty tests.
 */
import { distanceMeters } from '../core/geo';
import type { BookablesPort, CrowdPort, CrowdReading, EventsPort, PeoplePort, PlacesPort, Ports, RoutingPort } from '../ports/types';
import { SAMPLE_BOOKABLES, SAMPLE_EVENTS, SAMPLE_PEOPLE, SAMPLE_PLACES } from './fixtures.sample';

export * from './fixtures.sample';

export interface FakePortOptions {
  placesDown?: boolean; placesStale?: boolean; eventsDown?: boolean; routingDown?: boolean; bookablesDown?: boolean; peopleDown?: boolean;
  /** Reading the fake CrowdPort returns for every place (omit for no CrowdPort). */
  crowd?: CrowdReading;
  /** Give the fake RoutingPort its own rideLinks (URLs contain "from-port"). */
  rideLinks?: boolean;
}

export function createFakePorts(options: FakePortOptions = {}): Ports & { calls: string[] } {
  const calls: string[] = [];
  const places: PlacesPort = {
    async search(q) {
      calls.push(`places.search:${q.needKind}`);
      if (options.placesDown) throw new Error('SAMPLE outage');
      // Deliberately returns out-of-radius rows too, so skills must filter.
      const found = SAMPLE_PLACES.filter((p) => p.needKinds.includes(q.needKind)).map(({ needKinds: _n, ...p }) => p);
      return { places: found, source: options.placesStale ? 'google-stale' : 'google' };
    },
  };
  const events: EventsPort = {
    async search(q) {
      calls.push('events.search');
      if (options.eventsDown) return { events: [], source: 'unavailable' };
      const found = SAMPLE_EVENTS.filter((e) => (!q.startsAt || e.startsAt >= q.startsAt.slice(0, 10)) && distanceMeters(q, e) <= q.radiusMeters);
      return { events: found, source: found.length ? 'ok' : 'none' };
    },
  };
  const routing: RoutingPort = {
    async travel(from, to, mode) {
      calls.push(`routing.travel:${mode}`);
      if (options.routingDown) throw new Error('SAMPLE outage');
      const meters = Math.round(distanceMeters(from, to) * 1.3);
      return { meters, minutes: mode === 'walk' ? Math.max(1, Math.ceil(meters / 80)) : Math.ceil(meters / 400) + 10, basis: 'estimate' };
    },
    ...(options.rideLinks ? { rideLinks: (d: { name: string }) => (['uber', 'lyft'] as const).map((provider) => ({ provider, url: `https://example.test/from-port/${provider}/${encodeURIComponent(d.name)}`, fareChecked: false as const })) } : {}),
  };
  const crowd: CrowdPort | undefined = options.crowd ? { async typical() { calls.push('crowd.typical'); return options.crowd!; } } : undefined;
  const bookables: BookablesPort = {
    async forPlace(placeId) {
      calls.push(`bookables.forPlace:${placeId}`);
      if (options.bookablesDown) throw new Error('SAMPLE outage');
      return SAMPLE_BOOKABLES[placeId] ?? { bookables: [], tableLink: null };
    },
  };
  const people: PeoplePort = {
    async group(userId, names) {
      calls.push('people.group');
      if (options.peopleDown) throw new Error('SAMPLE outage');
      const circle = SAMPLE_PEOPLE[userId] ?? [];
      if (!names.length) return { members: circle, unresolved: [] };
      const norm = (s: string) => s.toLowerCase().replace(/^sample\s+/, '');
      const members = circle.filter((m) => names.some((n) => norm(m.displayName) === norm(n)));
      const unresolved = names.filter((n) => !circle.some((m) => norm(m.displayName) === norm(n)));
      return { members, unresolved };
    },
  };
  return { places, events, routing, bookables, people, ...(crowd ? { crowd } : {}), calls };
}
