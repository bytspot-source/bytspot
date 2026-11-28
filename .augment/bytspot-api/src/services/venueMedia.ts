import { config } from '../config';
import { venueControl } from './venueControl';
import { mediaUrl as vendorMediaUrl } from '../vendor/media';

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

/** The vendor's own approved files at the location linked to a venue, and whether its video may be shown. */
export interface LinkedVendorMedia {
  rows: VenueMediaRow[];
  videoAllowed: boolean;
}

/**
 * The curated media a guest may see, or null. Only a Bytspot-controlled venue
 * with at least one photo qualifies; a video alone is not a cover. The Bytspot
 * team's uploads come first, then the linked vendor's approved photos, so a
 * partner that uploaded its own photos is never shown bare.
 */
export function curatedVenueMedia(
  venue: { controlledAt?: Date | string | null },
  rows: VenueMediaRow[] | undefined,
  vendor?: LinkedVendorMedia | null,
): CuratedVenueMedia | null {
  if (venueControl(venue) !== 'bytspot') return null;
  const byPosition = (a: VenueMediaRow, b: VenueMediaRow) => a.position - b.position;
  const photosOf = (list: VenueMediaRow[]) => {
    const cover = list.find((row) => row.kind === 'cover');
    return [...(cover ? [cover] : []), ...list.filter((row) => row.kind === 'gallery').sort(byPosition)];
  };
  const team = rows ?? [];
  const own = vendor?.rows ?? [];
  const photos = [...photosOf(team).map((row) => venueMediaUrl(row.id)), ...photosOf(own).map((row) => vendorMediaUrl(row.id))]
    .slice(0, VENUE_GALLERY_CAP + 1);
  if (!photos.length) return null;
  const teamVideo = team.find((row) => row.kind === 'video');
  const ownVideo = vendor?.videoAllowed ? own.find((row) => row.kind === 'video') : undefined;
  return {
    imageUrl: photos[0],
    photoProvenance: 'bytspot_owned',
    photoAttribution: null,
    photoUrls: photos,
    vibeVideoUrl: teamVideo ? venueMediaUrl(teamVideo.id) : ownVideo ? vendorMediaUrl(ownVideo.id) : null,
  };
}

/**
 * What a Bytspot-controlled place shows from the business that runs it: its
 * name, phone, website and first approved menu. Only while its place and
 * business are live; the team's own website for the place wins.
 */
export function linkedVendorFacts(
  venue: { controlledAt: Date | null; website: string | null },
  location: {
    state: string;
    phone: string | null;
    website: string | null;
    seller: { state: string; legalName: string | null };
    media: VenueMediaRow[];
  } | null | undefined,
): { vendorName: string | null; phone: string | null; websiteUrl: string | null; menuUrl: string | null } | null {
  if (venueControl(venue) !== 'bytspot') return null;
  if (!location || location.state !== 'ACTIVE' || location.seller.state !== 'ACTIVE') return null;
  const menu = location.media.filter((row) => row.kind === 'menu').sort((a, b) => a.position - b.position)[0];
  return {
    vendorName: location.seller.legalName?.trim() || null,
    phone: location.phone?.trim() || null,
    websiteUrl: venue.website?.trim() || location.website?.trim() || null,
    menuUrl: menu ? vendorMediaUrl(menu.id) : null,
  };
}

/** A linked location's media, only while its place and business are live. */
export function linkedVendorMedia(location: {
  state: string;
  seller: { state: string; videoHostingAt: Date | null };
  media: VenueMediaRow[];
} | null | undefined): LinkedVendorMedia | null {
  if (!location || location.state !== 'ACTIVE' || location.seller.state !== 'ACTIVE') return null;
  return { rows: location.media, videoAllowed: location.seller.videoHostingAt !== null };
}
