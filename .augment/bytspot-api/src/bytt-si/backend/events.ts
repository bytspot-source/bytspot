import { cached } from '../../lib/redis';
import { distanceMeters } from '../../services/checkinProof';
import { mapTmEvent } from '../../trpc/eventsRouter';
import type { EventRecord, EventsPort } from '../ports/types';

/**
 * EventsPort over Bytspot parties (eventsRouter `nearby`, which applies the
 * membership/circle/block gates) and Ticketmaster (eventsRouter `mapTmEvent`).
 *
 * Deliberately does NOT call `events.list`: that procedure substitutes the
 * curated FALLBACK_EVENTS when the key is missing or Ticketmaster fails. Here a
 * failure is an empty answer marked unavailable, never a made-up event.
 */
export interface NearbyPartyRow {
  id: string; title: string; venueName: string | null; startsAt: string; endsAt: string | null;
  capability: 'book' | 'request' | 'details'; locationHidden: boolean;
  latitude: number | null; longitude: number | null; capacity: number; spacesRemaining: number;
}
export type TmMapped = Pick<ReturnType<typeof mapTmEvent>, 'id' | 'title' | 'venue' | 'address' | 'lat' | 'lng' | 'date' | 'time' | 'url'>;

export interface EventsAdapterDeps {
  nearbyParties(query: { lat: number; lng: number; radiusMiles: number }): Promise<NearbyPartyRow[]>;
  ticketmaster(): Promise<TmMapped[]>;
}

const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

/** Ticketmaster Atlanta events with no fallback: no key → []; HTTP error → throws. */
export async function ticketmasterEventsNoFallback(options: {
  apiKey: string; fetch?: typeof fetch;
  cache?: <T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>) => Promise<T>;
}): Promise<TmMapped[]> {
  if (!options.apiKey) return [];
  const fetchImpl = options.fetch ?? fetch;
  const cache = options.cache ?? cached;
  return cache('bytt-si:events:tm:atl:v1', 900, async () => {
    const params = new URLSearchParams({ apikey: options.apiKey, city: 'Atlanta', stateCode: 'GA', size: '50', sort: 'date,asc' });
    const res = await fetchImpl(`${TM_BASE}/events.json?${params}`, { signal: AbortSignal.timeout(8000) });
    // Thrown, not cached: a failure must not be stored as "no events".
    if (!res.ok) throw new Error(`Ticketmaster ${res.status}`);
    const data = (await res.json()) as { _embedded?: { events?: Parameters<typeof mapTmEvent>[0][] } };
    return (data._embedded?.events ?? []).map(mapTmEvent);
  });
}

/** "2026-11-06" + "20:00" in Atlanta → ISO with the correct EST/EDT offset. Null for TBD or malformed. */
export function atlantaLocalToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}/.test(time)) return null;
  const [hh, mm] = time.slice(0, 5).split(':');
  const guessUtc = new Date(`${date}T${hh}:${mm}:00Z`);
  if (Number.isNaN(guessUtc.getTime())) return null;
  const offsetFor = (at: Date) => {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
    const m = part.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : -300;
  };
  const offset = offsetFor(new Date(guessUtc.getTime() - offsetFor(guessUtc) * 60_000));
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${date}T${hh}:${mm}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const ms = (iso: string) => new Date(iso).getTime();
/** Overlaps the plan window. An event with no end is judged by its start. */
function inWindow(startsAt: string, endsAt: string | null, window: { startsAt: string | null; endsAt: string | null }): boolean {
  if (window.endsAt && ms(startsAt) > ms(window.endsAt)) return false;
  if (window.startsAt && ms(endsAt ?? startsAt) < ms(window.startsAt)) return false;
  return true;
}

export function createBackendEventsPort(deps: EventsAdapterDeps): EventsPort {
  return {
    async search(q) {
      const center = { lat: q.latitude, lng: q.longitude };
      const radiusMiles = Math.min(50, Math.max(0.5, Math.round((q.radiusMeters / 1609.344) * 10) / 10));
      const [parties, tm] = await Promise.allSettled([deps.nearbyParties({ lat: q.latitude, lng: q.longitude, radiusMiles }), deps.ticketmaster()]);
      if (parties.status === 'rejected' && tm.status === 'rejected') return { events: [], source: 'unavailable' };
      const events: EventRecord[] = [];
      for (const p of parties.status === 'fulfilled' ? parties.value : []) {
        if (p.locationHidden || p.latitude === null || p.longitude === null) continue;
        if (!inWindow(p.startsAt, p.endsAt, q)) continue;
        events.push({
          id: p.id, title: p.title, venueName: p.venueName ?? p.title, placeId: null, address: null,
          latitude: p.latitude, longitude: p.longitude, startsAt: p.startsAt, endsAt: p.endsAt,
          priceCents: null, capacity: p.spacesRemaining, bookableId: `party:${p.id}`, capability: p.capability,
        });
      }
      for (const e of tm.status === 'fulfilled' ? tm.value : []) {
        const startsAt = atlantaLocalToIso(e.date, e.time);
        if (!startsAt || e.lat === null || e.lng === null) continue;
        if (!inWindow(startsAt, null, q)) continue;
        if (distanceMeters(center, { lat: e.lat, lng: e.lng }) > q.radiusMeters) continue;
        events.push({
          id: `tm:${e.id}`, title: e.title, venueName: e.venue, placeId: null, address: e.address,
          latitude: e.lat, longitude: e.lng, startsAt, endsAt: null,
          // Ticketmaster's "from" price is not what a person pays; left unknown.
          priceCents: null, capacity: null, bookableId: null, capability: 'details',
        });
      }
      return { events, source: events.length ? 'ok' : 'none' };
    },
  };
}
