// A photograph is an endorsement. Only a picture Bytspot owns, or one a host
// uploaded to their own Party, may put a venue on the map as a pin; everything
// borrowed from a listing provider is a grey dot that exists for routing only.
//
// Provenance is stored. Pin eligibility is derived here and never persisted, so
// no row can claim a pin it has not earned. Anything unrecognised — including a
// value written by an older client — reads as `borrowed`, which is the closed
// side of the gate.

export type VenuePhotoProvenance = 'bytspot_owned' | 'party_media' | 'borrowed';

export const VENUE_PHOTO_PROVENANCE: readonly VenuePhotoProvenance[] = [
  'bytspot_owned',
  'party_media',
  'borrowed',
] as const;

/** The default a venue is created with, and the answer to anything unreadable. */
export const FALLBACK_PROVENANCE: VenuePhotoProvenance = 'borrowed';

/** Provenances that can earn a pin, given an actual photograph to back them. */
const OWNED: readonly VenuePhotoProvenance[] = ['bytspot_owned', 'party_media'] as const;

/** How a venue is allowed to appear on the map. A dot carries no photograph. */
export type VenueMapPresentation = 'pin' | 'dot';

export function isVenuePhotoProvenance(value: unknown): value is VenuePhotoProvenance {
  return typeof value === 'string' && (VENUE_PHOTO_PROVENANCE as readonly string[]).includes(value);
}

/** Narrow an unvalidated column, header, or payload value. Fails closed. */
export function readProvenance(value: unknown): VenuePhotoProvenance {
  return isVenuePhotoProvenance(value) ? value : FALLBACK_PROVENANCE;
}

/**
 * A pin needs both halves: a provenance we control *and* a photograph to show.
 * Owned provenance with no image is still a dot — the endorsement is the
 * picture, not the claim about it.
 */
export function earnsMapPin(input: { photoProvenance: unknown; imageUrl: string | null | undefined }): boolean {
  const hasPhoto = typeof input.imageUrl === 'string' && input.imageUrl.trim().length > 0;
  return hasPhoto && (OWNED as readonly string[]).includes(readProvenance(input.photoProvenance));
}

export function mapPresentation(input: { photoProvenance: unknown; imageUrl: string | null | undefined }): VenueMapPresentation {
  return earnsMapPin(input) ? 'pin' : 'dot';
}

/**
 * The photo a map surface may render. A dot must not carry one, so borrowed
 * imagery cannot leak onto the map through a field the client happens to read.
 * Detail views take `imageUrl` directly and attribute it.
 */
export function pinPhotoUrl(input: { photoProvenance: unknown; imageUrl: string | null | undefined }): string | null {
  return earnsMapPin(input) ? (input.imageUrl as string) : null;
}

/** The shape every venue payload carries so a client never has to infer the gate. */
export interface VenuePhotoProjection {
  photoProvenance: VenuePhotoProvenance;
  photoAttribution: string | null;
  mapPresentation: VenueMapPresentation;
  pinPhotoUrl: string | null;
}

export function projectVenuePhoto(input: {
  photoProvenance: unknown;
  photoAttribution?: string | null;
  imageUrl: string | null | undefined;
}): VenuePhotoProjection {
  const photoProvenance = readProvenance(input.photoProvenance);
  return {
    photoProvenance,
    // Borrowed imagery must name its source wherever it is shown.
    photoAttribution: input.photoAttribution ?? null,
    mapPresentation: mapPresentation({ photoProvenance, imageUrl: input.imageUrl }),
    pinPhotoUrl: pinPhotoUrl({ photoProvenance, imageUrl: input.imageUrl }),
  };
}
