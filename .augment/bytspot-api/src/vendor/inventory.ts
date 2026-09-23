import { z } from 'zod';
import { db } from '../lib/db';
import { deriveSlots, sellableSlots, type Commitment } from './availability';
import { distanceMiles } from './demand';
import { mediaUrl } from './media';
import { skuTemplate } from './windows';

/**
 * Live vendor inventory as a guest sees it.
 *
 * A card exists only for a window that is published, at an ACTIVE place, of
 * an ACTIVE business, with a slot that can actually be sold. Its imagery is
 * the seller's own: the window's cover, then the place's, and otherwise none.
 * Nothing here borrows a stock or Places photo, because a card that looks
 * sellable but shows someone else's picture is the failure this replaces.
 */

export const inventoryInput = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusMiles: z.number().min(0.5).max(50).default(15),
  domain: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(50).default(24),
});
export type InventoryInput = z.infer<typeof inventoryInput>;

export interface InventoryCard {
  windowId: string;
  sellerId: string;
  sellerName: string;
  skuTemplateId: string;
  title: string;
  domain: string;
  category: string;
  discoverType: string;
  priceCents: number;
  maxGuests: number;
  durationMins: number;
  intent: string;
  place: { label: string; address: string | null; lat: number; lng: number; phone: string | null; website: string | null };
  distanceMiles: number;
  coverUrl: string | null;
  galleryUrls: string[];
  nextSlot: { startsAt: string; remaining: number };
  /** The times a guest can ask for, soonest first. */
  upcomingSlots: { startsAt: string; remaining: number }[];
}

const UPCOMING_SLOTS = 6;

interface MediaRow {
  id: string;
  kind: string;
  position: number;
}

/** Window imagery first, then the place's. Positions keep the seller's order. */
export function pickImagery(windowMedia: MediaRow[], placeMedia: MediaRow[]): { coverUrl: string | null; galleryUrls: string[] } {
  const byPosition = (a: MediaRow, b: MediaRow) => a.position - b.position;
  const cover = windowMedia.find((row) => row.kind === 'cover') ?? placeMedia.find((row) => row.kind === 'cover');
  const gallery = [
    ...windowMedia.filter((row) => row.kind === 'gallery').sort(byPosition),
    ...placeMedia.filter((row) => row.kind === 'gallery').sort(byPosition),
  ];
  return { coverUrl: cover ? mediaUrl(cover.id) : null, galleryUrls: gallery.slice(0, 6).map((row) => mediaUrl(row.id)) };
}

/** A rough box so the database can use an index; exact distance is applied after. */
export function boundingBox(lat: number, lng: number, radiusMiles: number) {
  const latDelta = radiusMiles / 69;
  const lngDelta = radiusMiles / Math.max(1, 69 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - latDelta, maxLat: lat + latDelta, minLng: lng - lngDelta, maxLng: lng + lngDelta };
}

export async function liveInventory(input: InventoryInput, now: Date = new Date()): Promise<InventoryCard[]> {
  const box = boundingBox(input.lat, input.lng, input.radiusMiles);
  const mediaSelect = { select: { id: true, kind: true, position: true } } as const;

  const windows = await db.vendorAvailabilityWindow.findMany({
    where: {
      active: true,
      ...(input.domain ? { domain: input.domain } : {}),
      seller: { state: 'ACTIVE' },
      location: {
        state: 'ACTIVE',
        lat: { gte: box.minLat, lte: box.maxLat },
        lng: { gte: box.minLng, lte: box.maxLng },
      },
    },
    include: {
      seller: { select: { id: true, legalName: true } },
      location: { include: { media: { where: { kind: { in: ['cover', 'gallery'] } }, ...mediaSelect } } },
      media: { where: { kind: { in: ['cover', 'gallery'] } }, ...mediaSelect },
    },
    take: 200,
  });
  if (!windows.length) return [];

  const commitments = await db.vendorSlotCommitment.findMany({
    where: { windowId: { in: windows.map((window) => window.id) }, startsAt: { gte: now } },
  });
  const byWindow = new Map<string, Commitment[]>();
  for (const row of commitments) {
    const list = byWindow.get(row.windowId) ?? [];
    list.push({ startsAt: row.startsAt, committed: row.committed, blocked: row.blocked, closed: row.closed });
    byWindow.set(row.windowId, list);
  }

  const cards: InventoryCard[] = [];
  for (const window of windows) {
    const template = skuTemplate(window.skuTemplateId);
    if (!template) continue;

    const distance = distanceMiles(
      { latitude: input.lat, longitude: input.lng },
      { latitude: window.location.lat, longitude: window.location.lng },
    );
    if (distance > input.radiusMiles) continue;

    const slots = deriveSlots({
      window,
      timeZone: window.location.timezone,
      commitments: byWindow.get(window.id),
      now,
    });
    const open = sellableSlots(slots, window.domain, now);
    const next = open[0];
    // A published window with nothing to sell is not a card: it would promise a door that is shut.
    if (!next) continue;

    cards.push({
      windowId: window.id,
      sellerId: window.seller.id,
      sellerName: window.seller.legalName ?? window.location.label,
      skuTemplateId: template.id,
      title: template.title,
      domain: window.domain,
      category: template.category,
      discoverType: template.discoverType,
      priceCents: window.priceCents,
      maxGuests: window.maxGuests,
      durationMins: template.durationMins,
      intent: window.intent,
      place: {
        label: window.location.label,
        address: window.location.address,
        lat: window.location.lat,
        lng: window.location.lng,
        phone: window.location.phone,
        website: window.location.website,
      },
      distanceMiles: Math.round(distance * 10) / 10,
      ...pickImagery(window.media, window.location.media),
      nextSlot: { startsAt: next.startsAt.toISOString(), remaining: next.remaining },
      upcomingSlots: open
        .slice(0, UPCOMING_SLOTS)
        .map((slot) => ({ startsAt: slot.startsAt.toISOString(), remaining: slot.remaining })),
    });
  }

  return cards
    .sort((a, b) => a.distanceMiles - b.distanceMiles || a.nextSlot.startsAt.localeCompare(b.nextSlot.startsAt))
    .slice(0, input.limit);
}
