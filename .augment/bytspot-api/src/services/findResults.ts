// Find (Home search bar) — index-first place resolution.
//
// The Home search bar routes to FIND: Bytspot's own indexed places lead, and an
// external provider is consulted only to fill a short page. Two rules are
// enforced here by construction, not by convention downstream:
//
//   * Provenance is honest. Every result says whether it came from our index or
//     was resolved from the web, so the UI can never present a web result as a
//     Bytspot place.
//   * A resolved-only place is DETAILS. It has no supply behind it, so it can
//     never be labelled Book or Request. Both constructors set `capability` to
//     the literal 'details' — there is no branch that could make a Find result
//     bookable, so a resolved place cannot acquire an action it doesn't have.
//     Actionability is earned later, only when real supply is attached.

export type FindOrigin = 'index' | 'resolved';

export interface FindResult {
  origin: FindOrigin;
  /** Our venue id when indexed; a `gp:<placeId>` handle when resolved. */
  id: string;
  /** Our slug when indexed, so a tap deep-links into the Bytspot venue; null when resolved. */
  slug: string | null;
  googlePlaceId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  category: string | null;
  imageUrl: string | null;
  capability: 'details';
}

export interface IndexedVenue {
  id: string;
  name: string;
  slug: string;
  googlePlaceId: string | null;
  address: string;
  lat: number;
  lng: number;
  category: string;
  imageUrl: string | null;
}

export interface ResolvedPlace {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  primaryType: string | null;
  photoUrls?: string[];
}

export function indexedVenueToFindResult(venue: IndexedVenue): FindResult {
  return {
    origin: 'index',
    id: venue.id,
    slug: venue.slug,
    googlePlaceId: venue.googlePlaceId,
    name: venue.name,
    address: venue.address,
    lat: venue.lat,
    lng: venue.lng,
    category: venue.category,
    imageUrl: venue.imageUrl,
    capability: 'details',
  };
}

export function resolvedPlaceToFindResult(place: ResolvedPlace): FindResult {
  return {
    origin: 'resolved',
    id: `gp:${place.placeId}`,
    slug: null,
    googlePlaceId: place.placeId,
    name: place.name,
    address: place.address,
    lat: place.lat,
    lng: place.lng,
    category: place.primaryType,
    imageUrl: place.photoUrls?.[0] ?? null,
    capability: 'details',
  };
}

/**
 * Index leads; resolved places only fill what the index left empty. A resolved
 * place we already carry (same googlePlaceId) is dropped so our own copy — with
 * its slug and deep link — always wins the duplicate.
 */
export function mergeFindResults(indexed: FindResult[], resolved: FindResult[], limit: number): FindResult[] {
  const known = new Set(indexed.map((r) => r.googlePlaceId).filter((id): id is string => id !== null));
  const deduped = resolved.filter((r) => r.googlePlaceId === null || !known.has(r.googlePlaceId));
  return [...indexed, ...deduped].slice(0, limit);
}
