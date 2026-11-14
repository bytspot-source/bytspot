import { db } from '../lib/db';
import { captureError } from '../lib/observability';
import { BOOKING_PROVIDERS, BOOKING_PROVIDER_IDS, bookingLinkExpired, bookingLinkFresh, bookingUrlError, isAviationProvider, type BookingProvider } from './bookingProviders';

/**
 * Hand-checked booking links (OpenTable, Resy, Tock, FareHarbor, …) for places Bytspot does not sell.
 *
 * A link is a handoff, never a booking: the guest books with the provider,
 * Bytspot is not told the outcome, and nothing here issues a Pass. A Bytspot
 * admin sets each link on the place's venue after opening it, so the venue's
 * row names the date someone last checked it.
 */

export type TableBookingProvider = BookingProvider;

export type TableBookingLink = { provider: TableBookingProvider; label: string; url: string };

export const TABLE_BOOKING_PROVIDERS = BOOKING_PROVIDER_IDS;

/** Why a link would put a broken or foreign button on a card, or null when it is fit. */
export const tableBookingUrlError = bookingUrlError;

/**
 * The link as guests see it, or null when it fails the same checks an admin's
 * input does. Pass `checkedAt` on every guest path: a link nobody has checked
 * in 90 days is hidden until an admin checks it again. `expiresAt` hides an
 * event's link once the event is over. Admin views omit both. A flight link
 * (Blade, Wheels Up) is never a place's button on a guest path: it is offered
 * only as a way to another city (see conciergeTravelOptions).
 */
export function tableBookingLinkFrom(
  provider: string | null | undefined,
  url: string | null | undefined,
  checkedAt?: Date | null,
  expiresAt?: Date | null,
): TableBookingLink | null {
  if (!provider || !url || tableBookingUrlError(provider, url)) return null;
  if (checkedAt !== undefined && (!bookingLinkFresh(checkedAt) || isAviationProvider(provider))) return null;
  if (bookingLinkExpired(expiresAt)) return null;
  const known = provider as TableBookingProvider;
  return { provider: known, label: BOOKING_PROVIDERS[known].label, url: url.trim() };
}

/**
 * Read synchronously by every serializer that names a place, so it is kept in
 * memory and refreshed from the venues table. Admin writes refresh it at once;
 * another instance catches up within FRESH_MS.
 */
const FRESH_MS = 30_000;
let index = new Map<string, TableBookingLink>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
let pinned = false;

export async function refreshTableBookingLinks(): Promise<void> {
  const rows = await db.venue.findMany({
    where: { discoverable: true, googlePlaceId: { not: null }, bookingUrl: { not: null } },
    select: { googlePlaceId: true, bookingProvider: true, bookingUrl: true, bookingCheckedAt: true, bookingExpiresAt: true },
  });
  const next = new Map<string, TableBookingLink>();
  for (const row of rows) {
    const link = tableBookingLinkFrom(row.bookingProvider, row.bookingUrl, row.bookingCheckedAt, row.bookingExpiresAt);
    if (row.googlePlaceId && link) next.set(row.googlePlaceId, link);
  }
  if (!pinned) index = next;
  loadedAt = Date.now();
}

/**
 * Awaited before a read that names places. A failed refresh keeps the last
 * good list rather than dropping every link, and waits FRESH_MS to retry.
 */
export async function ensureTableBookingLinks(now = Date.now()): Promise<void> {
  if (pinned || now - loadedAt < FRESH_MS) return;
  loading ??= refreshTableBookingLinks()
    .catch((err) => {
      loadedAt = Date.now();
      captureError(err, { operation: 'refreshTableBookingLinks' });
    })
    .finally(() => { loading = null; });
  await loading;
}

/** Tests only: serve `links` instead of the venues table until restored. */
export function useTableBookingLinksForTest(links: Array<{ placeId: string; provider: string; url: string }>): () => void {
  const previous = { index, pinned };
  const next = new Map<string, TableBookingLink>();
  for (const entry of links) {
    const link = tableBookingLinkFrom(entry.provider, entry.url);
    if (!link) throw new Error(`invalid test booking link for ${entry.placeId}`);
    next.set(entry.placeId, link);
  }
  index = next;
  pinned = true;
  return () => { index = previous.index; pinned = previous.pinned; };
}

/** The listed link for a Google place, or null when the place is not listed. */
export function tableBookingLinkFor(placeId: string | null | undefined): TableBookingLink | null {
  if (!placeId) return null;
  return index.get(placeId.replace(/^places\//, '')) ?? null;
}
