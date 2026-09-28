import bookingLinks from './contracts/table-booking-links.json';

/**
 * Hand-checked OpenTable and Resy links for places Bytspot does not sell.
 *
 * A link is a handoff, never a booking: the guest books with the provider,
 * Bytspot is not told the outcome, and nothing here issues a Pass. The list is
 * checked in and edited by hand, so each change is reviewed in a PR and every
 * entry names the date someone last opened it.
 */

export type TableBookingProvider = 'opentable' | 'resy';

export type TableBookingLink = { provider: TableBookingProvider; label: string; url: string };

type LinkEntry = { placeId: string; name: string; provider: string; url: string; checkedAt: string };

const PROVIDERS: Record<TableBookingProvider, { label: string; hosts: string[] }> = {
  opentable: { label: 'OpenTable', hosts: ['opentable.com', 'www.opentable.com'] },
  resy: { label: 'Resy', hosts: ['resy.com'] },
};

const PLACE_ID = /^[A-Za-z0-9_-]+$/;
const CHECKED_AT = /^\d{4}-\d{2}-\d{2}$/;

/** Every reason the list is unfit to serve. Empty means it is fit. */
export function tableBookingLinkErrors(links: readonly LinkEntry[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  links.forEach((link, index) => {
    const at = `links[${index}]${link?.name ? ` (${link.name})` : ''}`;
    if (!link || typeof link !== 'object') { errors.push(`${at}: not an object`); return; }
    if (typeof link.placeId !== 'string' || !PLACE_ID.test(link.placeId)) errors.push(`${at}: placeId is missing or malformed`);
    else if (seen.has(link.placeId)) errors.push(`${at}: placeId is listed twice`);
    else seen.add(link.placeId);
    if (typeof link.name !== 'string' || !link.name.trim()) errors.push(`${at}: name is missing`);
    if (typeof link.checkedAt !== 'string' || !CHECKED_AT.test(link.checkedAt) || Number.isNaN(Date.parse(link.checkedAt))) {
      errors.push(`${at}: checkedAt must be a YYYY-MM-DD date`);
    }
    const provider = PROVIDERS[link.provider as TableBookingProvider];
    if (!provider) { errors.push(`${at}: provider must be opentable or resy`); return; }
    let url: URL | null = null;
    try { url = new URL(link.url); } catch { /* reported below */ }
    if (!url || url.protocol !== 'https:') errors.push(`${at}: url must be an https link`);
    else if (!provider.hosts.includes(url.hostname)) errors.push(`${at}: url must be on ${provider.hosts[0]}`);
  });
  return errors;
}

function buildIndex(links: readonly LinkEntry[]): Map<string, TableBookingLink> {
  const errors = tableBookingLinkErrors(links);
  // A bad entry would put a broken or foreign button on a card, so the list
  // refuses to load at all; the test suite trips on it before a deploy does.
  if (errors.length > 0) throw new Error(`table-booking-links.json is invalid:\n${errors.join('\n')}`);
  return new Map(links.map((link) => {
    const provider = link.provider as TableBookingProvider;
    return [link.placeId, { provider, label: PROVIDERS[provider].label, url: link.url }];
  }));
}

let index = buildIndex(bookingLinks.links as LinkEntry[]);

/** Tests only: serve `links` instead of the checked-in list until restored. */
export function useTableBookingLinksForTest(links: LinkEntry[]): () => void {
  const previous = index;
  index = buildIndex(links);
  return () => { index = previous; };
}

export const TABLE_BOOKING_LINKS_VERSION = bookingLinks.version;

/** The listed link for a Google place, or null when the place is not on the list. */
export function tableBookingLinkFor(placeId: string | null | undefined): TableBookingLink | null {
  if (!placeId) return null;
  return index.get(placeId.replace(/^places\//, '')) ?? null;
}
