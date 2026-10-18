import { Prisma, type VendorMenuDish } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { config } from '../config';
import { MEDIA_MENU_MIME, readReviewStatus } from '../vendor/media';
import { DISCOVERY_ALIASES, discoveryRail } from './discoveryTaxonomy';
import { distanceMeters, type RecommendVenue } from './recommendations';

export const MENU_REVIEW_MS = 30 * 24 * 60 * 60 * 1000;
export function menuRevisionMatches(revision: string, updatedAt: Date): boolean {
  return /^(0|[1-9]\d*)$/.test(revision) && Number.isSafeInteger(Number(revision))
    && revision === String(updatedAt.getTime());
}
export function menuSourceMime(mime: string): boolean {
  return (MEDIA_MENU_MIME as readonly string[]).includes(mime);
}
export const menuId = z.string().min(1).max(64);
export const menuVersion = z.string().datetime({ offset: true }).refine((s) => Number.isFinite(Date.parse(s)), 'Invalid version');
/** No markup, links, control/format characters, email or phone-number payloads. */
export const dishText = z.string().min(1).max(120)
  .refine((s) => !/[\p{C}\p{Zl}\p{Zp}<>@]/u.test(s), 'Use printable plain text')
  .transform((s) => s.trim()).pipe(z.string().min(1).max(120))
  .refine((s) => !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|mailto|tel|data|javascript):|www\.|[\p{L}\p{N}-]+\.[\p{L}]{2,}(?:[^\p{L}\p{N}]|$))/iu.test(s)
    && !/(?:\d[ .()+-]*){7,}/u.test(s), 'Use a dish name, not contact details or a URL');
export const submitMenuDishSchema = z.object({
  mediaId: menuId, dishName: dishText, aliases: z.array(dishText).max(5).default([]),
  dishId: menuId.optional(), expectedUpdatedAt: menuVersion.optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.dishId) !== Boolean(value.expectedUpdatedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Updates require the current version; creates must omit it' });
  }
});
export const withdrawMenuDishSchema = z.object({ expectedUpdatedAt: menuVersion }).strict();
export const reviewMenuDishSchema = z.object({
  dishId: menuId, approve: z.boolean(), expectedUpdatedAt: menuVersion,
  expectedMediaUpdatedAt: menuVersion, expectedVenueId: menuId.nullable(),
  note: z.string().trim().max(280).optional(),
}).strict();
export const linkMenuVenueSchema = z.object({
  locationId: menuId, venueId: menuId.nullable(), expectedVenueId: menuId.nullable(),
}).strict();

export class MenuEvidenceError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
export const pendingMenuReview = {
  reviewStatus: 'pending', reviewedAt: null, reviewedByUserId: null, reviewNote: null,
  reviewedVenueId: null, sourceUpdatedAt: null,
} as const;
export const menuMediaSelect = {
  id: true, sellerId: true, locationId: true, bookableId: true, kind: true,
  reviewStatus: true, updatedAt: true,
} satisfies Prisma.VendorMediaSelect;
type MenuDtoRow = VendorMenuDish & { media: { updatedAt: Date; reviewStatus: string } };
export function menuDishDto(row: MenuDtoRow) {
  return {
    id: row.id, dishName: row.dishName, aliases: row.aliases, mediaId: row.mediaId,
    sourceUrl: `${config.publicApiUrl}/media/menu-source/${encodeURIComponent(row.mediaId)}/${row.media.updatedAt.getTime()}`,
    reviewStatus: readReviewStatus(row.reviewStatus), reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString(),
    mediaUpdatedAt: row.media.updatedAt.toISOString(), mediaReviewStatus: row.media.reviewStatus,
  };
}
export async function listMenuDishes(tx: Prisma.TransactionClient, locationId: string) {
  const location = await tx.vendorLocation.findUnique({ where: { id: locationId }, select: { menuVenueId: true } });
  const rows = await tx.vendorMenuDish.findMany({ where: { locationId }, include: { media: { select: menuMediaSelect } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100 });
  return { venueId: location?.menuVenueId ?? null, dishes: rows.map(menuDishDto) };
}
/** No automatic retry: the caller must refresh explicit versions after a conflict. */
export async function menuTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await db.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
  catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002', 'P2003', 'P2004', 'P2025'].includes(error.code)) {
      throw new MenuEvidenceError(409, 'The menu or place changed. Refresh and try again.');
    }
    throw error;
  }
}
export async function linkMenuVenue(input: z.infer<typeof linkMenuVenueSchema>) {
  return menuTransaction(async (tx) => {
    const location = await tx.vendorLocation.findUnique({ where: { id: input.locationId }, select: { id: true, state: true, menuVenueId: true } });
    if (!location) throw new MenuEvidenceError(404, 'Place not found.');
    if (location.menuVenueId !== input.expectedVenueId) throw new MenuEvidenceError(409, 'The venue binding changed. Refresh first.');
    if (location.state !== 'ACTIVE') throw new MenuEvidenceError(409, 'The place must be active.');
    if (input.venueId && !await tx.venue.findFirst({ where: { id: input.venueId, discoverable: true }, select: { id: true } })) {
      throw new MenuEvidenceError(409, 'Choose a discoverable canonical venue.');
    }
    if (input.venueId !== location.menuVenueId) {
      const result = await tx.vendorLocation.updateMany({ where: { id: location.id, menuVenueId: input.expectedVenueId, state: 'ACTIVE' },
        data: { menuVenueId: input.venueId } });
      if (result.count !== 1) throw new MenuEvidenceError(409, 'The venue binding changed. Refresh first.');
      // Also enforced by SQL, including writers outside this API.
      await tx.vendorMenuDish.updateMany({ where: { locationId: location.id }, data: pendingMenuReview });
    }
    return { venueId: input.venueId };
  });
}
export async function reviewMenuDish(input: z.infer<typeof reviewMenuDishSchema>, reviewerId: string, now = new Date()) {
  return menuTransaction(async (tx) => {
    const row = await tx.vendorMenuDish.findUnique({ where: { id: input.dishId }, include: {
      media: true, location: { include: { seller: true, menuVenue: true } },
    } });
    if (!row) throw new MenuEvidenceError(404, 'Dish not found.');
    if (row.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt)
      || row.media.updatedAt.getTime() !== Date.parse(input.expectedMediaUpdatedAt)
      || row.location.menuVenueId !== input.expectedVenueId) throw new MenuEvidenceError(409, 'The dish, file or venue changed. Refresh first.');
    const media = row.media;
    if (media.locationId !== row.locationId || media.sellerId !== row.location.sellerId || media.kind !== 'menu' || media.bookableId !== null) {
      throw new MenuEvidenceError(409, 'Invalid menu source.');
    }
    if (input.approve && (row.location.state !== 'ACTIVE' || row.location.seller.state !== 'ACTIVE'
      || !row.location.menuVenue?.discoverable || !row.location.menuVenueId || media.reviewStatus !== 'approved'
      || media.byteSize <= 0 || !((media.bytes?.length ?? 0) > 0 || media.storageKey?.trim()))) {
      throw new MenuEvidenceError(409, 'Approve an uploaded menu and bind an active place to a discoverable venue first.');
    }
    const reviewStatus = input.approve ? 'approved' : 'rejected';
    const result = await tx.vendorMenuDish.updateMany({ where: { id: row.id, updatedAt: new Date(input.expectedUpdatedAt),
      media: { updatedAt: new Date(input.expectedMediaUpdatedAt) }, location: { menuVenueId: input.expectedVenueId } },
    data: { reviewStatus, reviewedAt: now, reviewedByUserId: reviewerId, reviewNote: input.note || null,
      reviewedVenueId: row.location.menuVenueId, sourceUpdatedAt: media.updatedAt } });
    if (result.count !== 1) throw new MenuEvidenceError(409, 'The dish changed. Refresh first.');
    return { reviewStatus };
  });
}

export interface MenuEvidenceSearch { query: string; mode: 'category' | 'name'; location: { lat: number; lng: number }; radius: number }
export interface MenuEvidenceResult {
  venue: RecommendVenue;
  evidence: { dishId: string; revision: string; dishName: string; source: 'vendor_menu'; mediaId: string; sourceUrl: string; reviewedAt: string; expiresAt: string; retrievedAt: string };
}
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const GENERIC = new Set(['restaurant', 'restaurants', 'coffee', 'place', 'places']);
// Menu text alone cannot substantiate quality, safety or dietary assurances.
const CLAIMS = new Set(['best', 'good', 'great', 'top', 'rated', 'rating', 'ratings', 'healthy', 'healthiest', 'vegan', 'vegetarian',
  'gluten', 'allergen', 'allergy', 'allergies', 'safe', 'halal', 'kosher', 'organic']);
export function menuQueryTerms(query: string): string[] {
  if (query.length > 120 || /[\p{C}<>@]/u.test(query)) return [];
  const terms = tokens(query);
  return !terms.length || terms.every((term) => GENERIC.has(term)) || terms.some((term) => CLAIMS.has(term)) ? [] : terms;
}
export function matchesMenuDish(query: string, dishName: string, aliases: string[]): boolean {
  const terms = menuQueryTerms(query);
  return terms.length > 0 && [dishName, ...aliases].some((name) =>
    ` ${tokens(name).join(' ')} `.includes(` ${terms.join(' ')} `));
}
function realCoordinates(point: { lat: number; lng: number }) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180
    && !(point.lat === 0 && point.lng === 0);
}
// Kept local: conciergePlaces imports conciergeDiscovery and would introduce a cycle.
export function menuSearchBounds(location: { lat: number; lng: number }, radius: number) {
  const angular = radius / 6371000, degrees = 180 / Math.PI;
  const lowLat = Math.max(-90, location.lat - angular * degrees), highLat = Math.min(90, location.lat + angular * degrees);
  const all = lowLat === -90 || highLat === 90;
  const delta = all ? 180 : Math.asin(Math.min(1, Math.sin(angular) / Math.cos(location.lat / degrees))) * degrees;
  const wrap = (lng: number) => ((lng + 540) % 360) - 180;
  return { lowLat, highLat, lowLng: all ? -180 : wrap(location.lng - delta), highLng: all ? 180 : wrap(location.lng + delta) };
}
type EvidenceRow = Omit<RecommendVenue, 'crowd'> & { dishId: string; dishName: string; aliases: string[]; mediaId: string; reviewedAt: Date; updatedAt: Date };
/** Database-only, no cache or provider calls. A review describes a menu, never stock/opening availability. */
export async function findMenuEvidence(search: MenuEvidenceSearch, now = new Date()): Promise<MenuEvidenceResult[]> {
  const terms = menuQueryTerms(search.query);
  if (search.mode !== 'category' || !terms.length || !realCoordinates(search.location) || !Number.isFinite(search.radius)
    || search.radius <= 0 || search.radius > 5000 || !Number.isFinite(now.getTime())) return [];
  const bounds = menuSearchBounds(search.location, search.radius);
  const longitude = bounds.lowLng <= bounds.highLng
    ? Prisma.sql`v.lng BETWEEN ${bounds.lowLng} AND ${bounds.highLng}`
    : Prisma.sql`(v.lng >= ${bounds.lowLng} OR v.lng <= ${bounds.highLng})`;
  const food = [...new Set(['eat_drink', 'coffee_shop', 'bakery', 'tea_house', 'food',
    ...Object.keys(DISCOVERY_ALIASES).filter((key) => discoveryRail(key) === 'eat_drink')])];
  // Contiguous whole-token phrase, parameterized before ranking or limiting.
  // Rank venues by spherical distance and dishes within each venue before the global cap.
  const rows = await db.$queryRaw<EvidenceRow[]>(Prisma.sql`
    WITH matched AS (
    SELECT v.id, v.slug, v.name, v.address, v.lat, v.lng, v.category, v.image_url AS "imageUrl",
      v.google_place_id AS "googlePlaceId", d.id AS "dishId", d.dish_name AS "dishName", d.aliases,
      d.media_id AS "mediaId", d.reviewed_at AS "reviewedAt", d.updated_at AS "updatedAt",
      2 * 6371000 * asin(sqrt(LEAST(1.0, GREATEST(0.0,
        power(sin(radians(v.lat - ${search.location.lat}) / 2), 2)
        + cos(radians(${search.location.lat})) * cos(radians(v.lat)) * power(sin(radians(v.lng - ${search.location.lng}) / 2), 2))))) AS distance
    FROM vendor_menu_dishes d JOIN vendor_locations l ON l.id = d.location_id
    JOIN vendor_sellers s ON s.id = l.seller_id JOIN vendor_media m ON m.id = d.media_id
    JOIN venues v ON v.id = l.menu_venue_id
    WHERE d.review_status = 'approved' AND d.reviewed_at > ${new Date(now.getTime() - MENU_REVIEW_MS)} AND d.reviewed_at <= ${now}
      AND d.reviewed_by_user_id IS NOT NULL AND d.source_updated_at = m.updated_at AND d.reviewed_venue_id = l.menu_venue_id
      AND l.state = 'ACTIVE' AND s.state = 'ACTIVE' AND v.discoverable
      AND m.seller_id = l.seller_id AND m.location_id = l.id AND m.bookable_id IS NULL AND m.kind = 'menu'
      AND m.review_status = 'approved' AND m.byte_size > 0
      AND m.mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
      AND (COALESCE(octet_length(m.bytes), 0) > 0 OR COALESCE(length(btrim(m.storage_key)), 0) > 0)
      AND v.lat BETWEEN -90 AND 90 AND v.lng BETWEEN -180 AND 180 AND NOT (v.lat = 0 AND v.lng = 0)
      AND v.lat BETWEEN ${bounds.lowLat} AND ${bounds.highLat} AND ${longitude}
      AND (lower(btrim(v.category)) IN (${Prisma.join(food)}) OR right(lower(btrim(v.category)), 11) = '_restaurant')
      AND EXISTS (SELECT 1 FROM unnest(ARRAY[d.dish_name] || d.aliases) AS names(value)
        WHERE strpos(' ' || btrim(regexp_replace(lower(names.value), '[^[:alnum:]]+', ' ', 'g')) || ' ', ${` ${terms.join(' ')} `}) > 0)
      AND 2 * 6371000 * asin(sqrt(LEAST(1.0, GREATEST(0.0,
        power(sin(radians(v.lat - ${search.location.lat}) / 2), 2)
        + cos(radians(${search.location.lat})) * cos(radians(v.lat)) * power(sin(radians(v.lng - ${search.location.lng}) / 2), 2))))) <= ${search.radius}
    ), deduplicated AS (
      SELECT *, row_number() OVER (PARTITION BY id, btrim(regexp_replace(lower("dishName"), '[^[:alnum:]]+', ' ', 'g'))
        ORDER BY "reviewedAt" DESC, "dishId" ASC) AS name_rank FROM matched
    ), ranked AS (
      SELECT *, dense_rank() OVER (ORDER BY distance ASC, id ASC) AS venue_rank,
        row_number() OVER (PARTITION BY id ORDER BY "reviewedAt" DESC, "dishId" ASC) AS dish_rank
      FROM deduplicated WHERE name_rank = 1
    )
    SELECT * FROM ranked WHERE venue_rank <= 20 AND dish_rank <= 3
    ORDER BY distance ASC, id ASC, "reviewedAt" DESC, "dishId" ASC LIMIT 200`);
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  const results: MenuEvidenceResult[] = [];
  rows.sort((a, b) => distanceMeters(search.location, a) - distanceMeters(search.location, b)
    || a.id.localeCompare(b.id) || b.reviewedAt.getTime() - a.reviewedAt.getTime() || a.dishId.localeCompare(b.dishId));
  for (const row of rows) {
    if (!realCoordinates(row) || !(distanceMeters(search.location, row) <= search.radius) || discoveryRail(row.category) !== 'eat_drink'
      || !matchesMenuDish(search.query, row.dishName, row.aliases) || !dishText.safeParse(row.dishName).success
      || row.reviewedAt > now || now.getTime() - row.reviewedAt.getTime() >= MENU_REVIEW_MS) continue;
    const count = counts.get(row.id) ?? 0, key = `${row.id}:${tokens(row.dishName).join(' ')}`;
    if (count >= 3 || (!count && counts.size >= 20) || seen.has(key)) continue;
    counts.set(row.id, count + 1); seen.add(key);
    results.push({ venue: { id: row.id, slug: row.slug, name: row.name, address: row.address, lat: row.lat, lng: row.lng,
      category: row.category, imageUrl: row.imageUrl, googlePlaceId: row.googlePlaceId, crowd: null },
    evidence: { dishId: row.dishId, revision: String(row.updatedAt.getTime()), dishName: row.dishName, source: 'vendor_menu', mediaId: row.mediaId,
      sourceUrl: `${config.publicApiUrl}/media/menu-evidence/${encodeURIComponent(row.dishId)}/${row.updatedAt.getTime()}`,
      reviewedAt: row.reviewedAt.toISOString(), expiresAt: new Date(row.reviewedAt.getTime() + MENU_REVIEW_MS).toISOString(), retrievedAt: now.toISOString() } });
  }
  return results;
}
