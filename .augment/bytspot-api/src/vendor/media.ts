import { config } from '../config';
import type { SeatRole, SellerState } from './contract';
import { roleCapabilities, roleScope } from './contract';

/**
 * Attachments on a PIN or a window. Not a noun: kind is a tag on an existing
 * parent. A menu file is display on the place; anything that sells is a
 * window (what the console still calls a bookable) with its own cover.
 */
export const MEDIA_KINDS = ['cover', 'gallery', 'video', 'menu'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaParent = 'location' | 'bookable';

export const MEDIA_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MEDIA_MENU_MIME = [...MEDIA_IMAGE_MIME, 'application/pdf'] as const;

export const MEDIA_CAPS = {
  cover: { location: 1, bookable: 1 },
  gallery: { location: 8, bookable: 3 },
  menu: { location: 3, bookable: 0 },
  video: { location: 1, bookable: 0 },
} as const;

export const MEDIA_MAX_IMAGE_BYTES = 2_000_000;
export const MEDIA_MAX_MENU_BYTES = 8_000_000;
export const MEDIA_MAX_PIXELS = 4_096;

export type MediaRefusal =
  | 'forbidden'
  | 'unknown-kind'
  | 'kind-not-on-parent'
  | 'video-unavailable'
  | 'bad-payload'
  | 'too-large'
  | 'at-capacity'
  | 'cover-has-no-index';

export interface MediaDto {
  id: string;
  kind: MediaKind;
  position: number;
  mimeType: string;
  byteSize: number;
  url: string;
}

export function mediaUrl(id: string): string {
  return `${config.publicApiUrl}/media/vendor/${encodeURIComponent(id)}`;
}

export function mediaDto(row: {
  id: string;
  kind: string;
  position: number;
  mimeType: string;
  byteSize: number;
}): MediaDto {
  return {
    id: row.id,
    kind: row.kind as MediaKind,
    position: row.position,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    url: mediaUrl(row.id),
  };
}

export function coverUrlFor(rows: { id: string; kind: string }[]): string | undefined {
  const cover = rows.find((row) => row.kind === 'cover');
  return cover ? mediaUrl(cover.id) : undefined;
}

/**
 * Writes are inventory, so they need PUBLISH on the role. Seller state is a
 * separate ceiling: a draft owner must be able to hang photos before they go
 * live, and a suspended business must not.
 */
export function vendorCanEditMedia(role: SeatRole, sellerState: SellerState): boolean {
  if (sellerState === 'SUSPENDED' || sellerState === 'CLOSED') return false;
  return roleCapabilities(role).includes('PUBLISH');
}

/**
 * Assigned-scope seats see only the locations named on the seat. An empty
 * assignment sees nothing rather than everything.
 */
export function seatCanSeeLocation(role: SeatRole, locationIds: string[], locationId: string): boolean {
  if (roleScope(role) === 'all') return true;
  return locationIds.includes(locationId);
}

/**
 * Assigned-scope seats see only the windows named on `bookableIds`. The
 * console's bookable id is the availability window.
 */
export function seatCanSeeBookable(role: SeatRole, bookableIds: string[], bookableId: string): boolean {
  if (roleScope(role) === 'all') return true;
  return bookableIds.includes(bookableId);
}

export function isMediaKind(value: string): value is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(value);
}

export function kindAllowedOn(parent: MediaParent, kind: MediaKind): boolean {
  return MEDIA_CAPS[kind][parent] > 0;
}

export function capFor(parent: MediaParent, kind: MediaKind): number {
  return MEDIA_CAPS[kind][parent];
}

export function nextPosition(kind: MediaKind, occupied: number[]): number {
  if (kind === 'cover' || kind === 'video') return 0;
  const taken = new Set(occupied);
  const cap = Math.max(...Object.values(MEDIA_CAPS[kind]), 0);
  for (let position = 0; position < cap; position += 1) {
    if (!taken.has(position)) return position;
  }
  return occupied.length;
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function hasPdfSignature(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
}

/**
 * Reads intrinsic dimensions from an image header. Returns null when the format
 * is one we cannot measure cheaply (animated or extended WebP), in which case
 * the byte ceiling remains the only limit.
 */
export function imageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png') {
    return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return null;
  }
  const chunk = bytes.length >= 16 ? bytes.toString('ascii', 12, 16) : '';
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const header = bytes.readUInt32LE(21);
    return { width: (header & 0x3fff) + 1, height: ((header >> 14) & 0x3fff) + 1 };
  }
  return null;
}

export type ParsedMedia =
  | { ok: true; bytes: Buffer; mimeType: string }
  | { ok: false; reason: Extract<MediaRefusal, 'bad-payload' | 'too-large' | 'video-unavailable'> };

const IMAGE_URI = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const PDF_URI = /^data:(application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/;
const VIDEO_URI = /^data:video\//i;

export function parseVendorMediaDataUri(kind: MediaKind, dataUri: string): ParsedMedia {
  if (kind === 'video' || VIDEO_URI.test(dataUri)) {
    return { ok: false, reason: 'video-unavailable' };
  }

  const allowed = kind === 'menu' ? MEDIA_MENU_MIME : MEDIA_IMAGE_MIME;
  const match = (kind === 'menu' ? PDF_URI.exec(dataUri) : null) ?? IMAGE_URI.exec(dataUri);
  if (!match) return { ok: false, reason: 'bad-payload' };

  const mimeType = match[1];
  if (!(allowed as readonly string[]).includes(mimeType)) return { ok: false, reason: 'bad-payload' };

  const bytes = Buffer.from(match[2], 'base64');
  const maxBytes = mimeType === 'application/pdf' ? MEDIA_MAX_MENU_BYTES : MEDIA_MAX_IMAGE_BYTES;
  if (bytes.length === 0 || bytes.length > maxBytes) return { ok: false, reason: 'too-large' };
  if (bytes.toString('base64') !== match[2]) return { ok: false, reason: 'bad-payload' };

  if (mimeType === 'application/pdf') {
    if (!hasPdfSignature(bytes)) return { ok: false, reason: 'bad-payload' };
    return { ok: true, bytes, mimeType };
  }

  if (!hasImageSignature(bytes, mimeType)) return { ok: false, reason: 'bad-payload' };
  const dimensions = imageDimensions(bytes, mimeType);
  if (dimensions && Math.max(dimensions.width, dimensions.height) > MEDIA_MAX_PIXELS) {
    return { ok: false, reason: 'bad-payload' };
  }
  return { ok: true, bytes, mimeType };
}

export type UploadPlan =
  | { ok: true; kind: MediaKind; position: number; replace: boolean }
  | { ok: false; reason: MediaRefusal };

/**
 * Decides whether this upload fits the parent. Counting happens with the
 * already-stored rows so two covers cannot land because the client omitted an
 * index.
 */
export function planUpload(options: {
  parent: MediaParent;
  kind: string;
  position?: number;
  existing: { kind: string; position: number }[];
}): UploadPlan {
  if (!isMediaKind(options.kind)) return { ok: false, reason: 'unknown-kind' };
  const kind = options.kind;

  if (!kindAllowedOn(options.parent, kind)) return { ok: false, reason: 'kind-not-on-parent' };
  if (kind === 'video') return { ok: false, reason: 'video-unavailable' };

  if (kind === 'cover') {
    if (options.position !== undefined && options.position !== 0) return { ok: false, reason: 'cover-has-no-index' };
    return { ok: true, kind, position: 0, replace: options.existing.some((row) => row.kind === 'cover') };
  }

  const ofKind = options.existing.filter((row) => row.kind === kind);
  const cap = capFor(options.parent, kind);
  if (options.position === undefined) {
    if (ofKind.length >= cap) return { ok: false, reason: 'at-capacity' };
    return { ok: true, kind, position: nextPosition(kind, ofKind.map((row) => row.position)), replace: false };
  }

  if (!Number.isInteger(options.position) || options.position < 0 || options.position >= cap) {
    return { ok: false, reason: 'at-capacity' };
  }
  const occupied = ofKind.find((row) => row.position === options.position);
  if (occupied) return { ok: true, kind, position: options.position, replace: true };
  if (ofKind.length >= cap) return { ok: false, reason: 'at-capacity' };
  return { ok: true, kind, position: options.position, replace: false };
}

export const MEDIA_REFUSALS: Record<MediaRefusal, string> = {
  forbidden: 'Your role cannot do that',
  'unknown-kind': 'Unknown media kind',
  'kind-not-on-parent': 'That file does not belong on this',
  'video-unavailable': 'Video uploads are not available yet',
  'bad-payload': 'Use a JPEG, PNG, WebP, or PDF',
  'too-large': 'That file is too large',
  'at-capacity': 'This already has as many files as it can hold',
  'cover-has-no-index': 'A cover cannot specify a slot',
};

export function mediaHttpStatus(reason: MediaRefusal): 400 | 403 | 409 | 413 {
  if (reason === 'forbidden') return 403;
  if (reason === 'at-capacity') return 409;
  if (reason === 'too-large' || reason === 'video-unavailable') return 413;
  return 400;
}
