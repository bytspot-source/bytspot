import { db } from '../lib/db';
import { captureError } from '../lib/observability';

/**
 * Hand-checked OpenTable and Resy links for places Bytspot does not sell.
 *
 * A link is a handoff, never a booking: the guest books with the provider,
 * Bytspot is not told the outcome, and nothing here issues a Pass. A Bytspot
 * admin sets each link on the place's venue after opening it, so the venue's
 * row names the date someone last checked it.
 */

export type TableBookingProvider = 'opentable' | 'resy';

export type TableBookingLink = { provider: TableBookingProvider; label: string; url: string };

const PROVIDERS: Record<TableBookingProvider, { label: string; hosts: string[] }> = {
  opentable: { label: 'OpenTable', hosts: ['opentable.com', 'www.opentable.com'] },
  resy: { label: 'Resy', hosts: ['resy.com'] },
};

export const TABLE_BOOKING_PROVIDERS = Object.keys(PROVIDERS) as TableBookingProvider[];

/** Why a link would put a broken or foreign button on a card, or null when it is fit. */
export function tableBookingUrlError(provider: string, url: string): string | null {
  const rule = PROVIDERS[provider as TableBookingProvider];
  if (!rule) return 'Pick OpenTable or Resy.';
  let parsed: URL | null = null;
  try { parsed = new URL(url.trim()); } catch { /* reported below */ }
  if (!parsed || parsed.protocol !== 'https:') return 'Paste the full https:// link.';
  if (!rule.hosts.includes(parsed.hostname)) return `That link is not on ${rule.hosts[0]}.`;
  return null;
}

/** The link as guests see it, or null when it fails the same checks an admin's input does. */
export function tableBookingLinkFrom(provider: string | null | undefined, url: string | null | undefined): TableBookingLink | null {
  if (!provider || !url || tableBookingUrlError(provider, url)) return null;
  const known = provider as TableBookingProvider;
  return { provider: known, label: PROVIDERS[known].label, url: url.trim() };
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
    select: { googlePlaceId: true, bookingProvider: true, bookingUrl: true },
  });
  const next = new Map<string, TableBookingLink>();
  for (const row of rows) {
    const link = tableBookingLinkFrom(row.bookingProvider, row.bookingUrl);
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
