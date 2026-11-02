/**
 * Data ports. The engine and skills only see these interfaces; production
 * adapters wrap the bytspot-api services (see README "Wiring real ports").
 */

export interface LatLng { latitude: number; longitude: number }

/** Raw crowd reading from the backend. `source` uses backend values: 'typical' or a live source. */
export interface CrowdReading { level: number; source: string; observedAt?: string | null }

export interface PlaceRecord {
  placeId: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  types: string[];
  rating: number | null;
  isOpen: boolean | null;
  /** Per-person price if known, with how it is known. Null = unknown. */
  priceCents: number | null;
  priceBasis: 'provider_listed' | 'estimate' | null;
  crowd: CrowdReading | null;
}
export type PlacesSource = 'google' | 'google-stale' | 'none' | 'unavailable';
export interface PlacesPort {
  search(query: { query: string; needKind: string; latitude: number; longitude: number; radiusMeters: number }): Promise<{ places: PlaceRecord[]; source: PlacesSource }>;
}

export interface EventRecord {
  id: string;
  title: string;
  venueName: string;
  placeId: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
  startsAt: string;
  endsAt: string | null;
  /** Per person. Null unless a real source states it. */
  priceCents: number | null;
  /** Seats still available, when the supply counts them. */
  capacity: number | null;
  /** Plan selection id for Bytspot supply, e.g. `party:<id>` (plans.createWithBookables). Null for outside events. */
  bookableId: string | null;
  /** Same values as bookableProjection: book | request | details. */
  capability: 'book' | 'request' | 'details';
}
export interface EventsPort {
  /** Must return `{ events: [], source: 'unavailable' }` on failure — never fallback or curated events. */
  search(query: { latitude: number; longitude: number; radiusMeters: number; startsAt: string | null; endsAt: string | null; query?: string }): Promise<{ events: EventRecord[]; source: 'ok' | 'none' | 'unavailable' }>;
}

export interface TravelEstimate { minutes: number; meters: number; basis: 'provider' | 'estimate' }
export interface RoutingPort {
  travel(from: LatLng, to: LatLng, mode: 'walk' | 'drive'): Promise<TravelEstimate | null>;
  /** Optional: hand-off links from the backend (mobilityRouter.handoffUrl). Core links are used when absent. */
  rideLinks?(destination: { latitude: number; longitude: number; name: string; address: string | null }): Array<{ provider: 'uber' | 'lyft'; url: string; fareChecked: false }>;
}

/** Typical-only crowd patterns. Whatever it returns is always labeled typical. */
export interface CrowdPort {
  typical(place: { placeId: string; name: string; types: string[] }, at: string): Promise<CrowdReading | null>;
}

/** Mirrors prisma `Bookable`. */
export interface BookableRecord {
  id: string;
  sourceKind: string;
  capability: string;
  provider: string | null;
  tierName: string;
  priceCents: number;
  capacity: number;
}
export interface BookablesPort {
  forPlace(placeId: string): Promise<{ bookables: BookableRecord[]; tableLink: { provider: 'opentable' | 'resy'; label: string; url: string } | null }>;
}

export interface PersonRecord { userId: string; displayName: string; preferences: string[] }
export interface PeoplePort {
  group(userId: string, names: string[]): Promise<{ members: PersonRecord[]; unresolved: string[] }>;
}

export interface Ports {
  places: PlacesPort;
  events: EventsPort;
  routing: RoutingPort;
  bookables: BookablesPort;
  people: PeoplePort;
  crowd?: CrowdPort;
}
