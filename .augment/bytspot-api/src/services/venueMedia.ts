import { config } from '../config';
import { venueControl } from './venueControl';

// Bytspot-curated media on a venue: one cover, a gallery and one video, all
// uploaded by the Bytspot team. Guests see them only while the venue is
// Bytspot-controlled; a listed venue keeps its files but shows Google's.

export const VENUE_MEDIA_KINDS = ['cover', 'gallery', 'video'] as const;
export type VenueMediaKind = (typeof VENUE_MEDIA_KINDS)[number];

export const VENUE_GALLERY_CAP = 8;

export function isVenueMediaKind(value: string): value is VenueMediaKind {
  return (VENUE_MEDIA_KINDS as readonly string[]).includes(value);
}

export function venueMediaUrl(id: string): string {
  return `${config.publicApiUrl}/media/venue/${encodeURIComponent(id)}`;
}

export function venueObjectKey(input: { venueId: string; kind: VenueMediaKind; mediaId: string }): string {
  return `venue/${input.venueId}/${input.kind}/${input.mediaId}`;
}

export interface VenueMediaRow {
  id: string;
  kind: string;
  position: number;
}

/** What a guest-facing venue payload carries once curated media replaces the venue's own photo fields. */
export interface CuratedVenueMedia {
  imageUrl: string;
  photoProvenance: 'bytspot_owned';
  photoAttribution: null;
  photoUrls: string[];
  vibeVideoUrl: string | null;
}

/**
 * The curated media a guest may see, or null. Only a Bytspot-controlled venue
 * with at least one photo qualifies; a video alone is not a cover.
 */
export function curatedVenueMedia(
  venue: { controlledAt?: Date | string | null },
  rows: VenueMediaRow[] | undefined,
): CuratedVenueMedia | null {
  if (venueControl(venue) !== 'bytspot' || !rows?.length) return null;
  const byPosition = (a: VenueMediaRow, b: VenueMediaRow) => a.position - b.position;
  const cover = rows.find((row) => row.kind === 'cover');
  const gallery = rows.filter((row) => row.kind === 'gallery').sort(byPosition);
  const photos = [...(cover ? [cover] : []), ...gallery];
  if (!photos.length) return null;
  const video = rows.find((row) => row.kind === 'video');
  return {
    imageUrl: venueMediaUrl(photos[0].id),
    photoProvenance: 'bytspot_owned',
    photoAttribution: null,
    photoUrls: photos.map((row) => venueMediaUrl(row.id)),
    vibeVideoUrl: video ? venueMediaUrl(video.id) : null,
  };
}
