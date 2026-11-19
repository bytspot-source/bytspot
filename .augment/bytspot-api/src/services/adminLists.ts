/**
 * Search, filters, sort, A-Z letters, pages and the "Needs attention" counts
 * for the admin Places and Vendors tabs. Pure: the routers load light rows and
 * counts, and this decides which page to show.
 */
import { z } from 'zod';
import { discoveryRail, DISCOVERY_RAILS } from './discoveryTaxonomy';
import { bookingLinkCheck, bookingLinkExpired } from './bookingProviders';

export const ADMIN_PAGE_SIZE = 50;
/** Booking taps in 30 days that make a place not on Bytspot worth pitching. */
export const PITCH_ATTENTION_TAPS = 10;
export const INVITE_STALE_DAYS = 7;
export const SETUP_STUCK_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "R" for Rumi's, "#" for a name that does not start with a letter. */
export function letterOf(name: string): string {
  const first = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : '#';
}

const matches = (query: string, ...fields: (string | null | undefined)[]) => {
  const q = query.trim().toLowerCase();
  return !q || fields.some((field) => field?.toLowerCase().includes(q));
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

// ── Places ──────────────────────────────────────────────────────────────

export const PLACE_STATUSES = ['live', 'hidden', 'link_due', 'no_link'] as const;
export const PLACE_SORTS = ['az', 'newest', 'taps', 'checkins', 'due'] as const;

export const placesListInput = z.object({
  query: z.string().trim().max(100).optional(),
  rail: z.enum(DISCOVERY_RAILS).optional(),
  provider: z.string().trim().max(40).optional(),
  status: z.enum(PLACE_STATUSES).optional(),
  letter: z.string().regex(/^([A-Z]|#)$/).optional(),
  sort: z.enum(PLACE_SORTS).default('newest'),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(200).default(ADMIN_PAGE_SIZE),
}).strict();
export type PlacesListInput = z.input<typeof placesListInput>;

export interface PlaceRow {
  id: string; name: string; address: string; category: string; discoverable: boolean;
  bookingProvider: string | null; bookingUrl: string | null; bookingCheckedAt: Date | null; bookingExpiresAt: Date | null;
  listedAt: Date | null; controlledAt: Date | null;
}

export interface PlacesAttention {
  linksDue: number;
  hidden: number;
  /** Not on Bytspot yet, with at least PITCH_ATTENTION_TAPS booking taps in 30 days; busiest first. */
  toPitch: { venueId: string; name: string; taps: number }[];
}

function linkDue(row: PlaceRow, now: number): { due: boolean; dueAt: number } {
  if (!row.bookingUrl) return { due: false, dueAt: Number.MAX_SAFE_INTEGER };
  if (bookingLinkExpired(row.bookingExpiresAt, now)) return { due: true, dueAt: row.bookingExpiresAt?.getTime() ?? 0 };
  const check = bookingLinkCheck(row.bookingCheckedAt, now);
  return { due: check.status !== 'ok', dueAt: check.dueAt?.getTime() ?? 0 };
}

export function queryPlaces(
  rows: readonly PlaceRow[],
  last30: { taps: ReadonlyMap<string, number>; checkIns: ReadonlyMap<string, number> },
  rawInput: PlacesListInput = {},
  now = new Date(),
): { ids: string[]; total: number; letters: string[]; attention: PlacesAttention } {
  const input = placesListInput.parse(rawInput);
  const at = now.getTime();
  const taps = (id: string) => last30.taps.get(id) ?? 0;
  const checkIns = (id: string) => last30.checkIns.get(id) ?? 0;

  const attention: PlacesAttention = {
    linksDue: rows.filter((r) => r.discoverable && linkDue(r, at).due).length,
    hidden: rows.filter((r) => !r.discoverable).length,
    toPitch: rows.filter((r) => r.discoverable && !r.controlledAt && taps(r.id) >= PITCH_ATTENTION_TAPS)
      .sort((a, b) => taps(b.id) - taps(a.id) || byName(a, b)).slice(0, 5)
      .map((r) => ({ venueId: r.id, name: r.name, taps: taps(r.id) })),
  };

  const filtered = rows.filter((r) => {
    if (!matches(input.query ?? '', r.name, r.address)) return false;
    if (input.rail && discoveryRail(r.category) !== input.rail) return false;
    if (input.provider && (input.provider === 'none' ? r.bookingUrl : r.bookingProvider !== input.provider)) return false;
    switch (input.status) {
      case 'live': if (!r.discoverable) return false; break;
      case 'hidden': if (r.discoverable) return false; break;
      case 'link_due': if (!r.discoverable || !linkDue(r, at).due) return false; break;
      case 'no_link': if (r.bookingUrl) return false; break;
    }
    return true;
  });
  const letters = [...new Set(filtered.map((r) => letterOf(r.name)))].sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
  const lettered = input.letter ? filtered.filter((r) => letterOf(r.name) === input.letter) : filtered;
  const sorted = [...lettered].sort((a, b) => {
    switch (input.sort) {
      case 'az': return byName(a, b);
      case 'taps': return taps(b.id) - taps(a.id) || byName(a, b);
      case 'checkins': return checkIns(b.id) - checkIns(a.id) || byName(a, b);
      case 'due': return linkDue(a, at).dueAt - linkDue(b, at).dueAt || byName(a, b);
      default: return (b.listedAt?.getTime() ?? 0) - (a.listedAt?.getTime() ?? 0) || byName(a, b);
    }
  });
  return { ids: sorted.slice(input.offset, input.offset + input.limit).map((r) => r.id), total: sorted.length, letters, attention };
}

// ── Vendors ─────────────────────────────────────────────────────────────

export const VENDOR_STATUSES = ['waiting', 'live', 'paused', 'setup', 'invite_stale', 'stuck'] as const;
export const VENDOR_SORTS = ['priority', 'az', 'newest'] as const;

export const vendorsListInput = z.object({
  query: z.string().trim().max(100).optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
  letter: z.string().regex(/^([A-Z]|#)$/).optional(),
  sort: z.enum(VENDOR_SORTS).default('priority'),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(200).default(ADMIN_PAGE_SIZE),
}).strict();
export type VendorsListInput = z.input<typeof vendorsListInput>;

export interface VendorRow {
  sellerId: string; legalName: string; contactEmail: string | null; state: string; awaitingApproval: boolean;
  pausedAt: Date | null; createdAt: Date; ownerInvitedAt: Date | null;
  locations: { label: string | null; address: string | null }[];
}

export type VendorsAttention = Record<'waiting' | 'invite_stale' | 'stuck' | 'paused', number>;

function vendorStatus(row: VendorRow, status: (typeof VENDOR_STATUSES)[number], now: number): boolean {
  switch (status) {
    case 'waiting': return row.awaitingApproval;
    case 'live': return row.state === 'ACTIVE';
    case 'paused': return row.state === 'SUSPENDED' || Boolean(row.pausedAt);
    case 'setup': return (row.state === 'DRAFT' || row.state === 'PENDING') && !row.awaitingApproval;
    case 'invite_stale': return row.ownerInvitedAt !== null && now - row.ownerInvitedAt.getTime() > INVITE_STALE_DAYS * DAY_MS;
    case 'stuck': return row.state === 'DRAFT' && !row.awaitingApproval && now - row.createdAt.getTime() > SETUP_STUCK_DAYS * DAY_MS;
  }
}

export function queryVendors<T extends VendorRow>(rows: readonly T[], rawInput: VendorsListInput = {}, now = new Date()):
  { page: T[]; total: number; letters: string[]; attention: VendorsAttention } {
  const input = vendorsListInput.parse(rawInput);
  const at = now.getTime();
  const count = (status: (typeof VENDOR_STATUSES)[number]) => rows.filter((r) => vendorStatus(r, status, at)).length;
  const attention: VendorsAttention = { waiting: count('waiting'), invite_stale: count('invite_stale'), stuck: count('stuck'), paused: count('paused') };
  const name = (r: VendorRow) => ({ name: r.legalName });
  const filtered = rows.filter((r) => matches(input.query ?? '', r.legalName, r.contactEmail, ...r.locations.flatMap((l) => [l.label, l.address]))
    && (!input.status || vendorStatus(r, input.status, at)));
  const letters = [...new Set(filtered.map((r) => letterOf(r.legalName)))].sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
  const lettered = input.letter ? filtered.filter((r) => letterOf(r.legalName) === input.letter) : filtered;
  const sorted = [...lettered].sort((a, b) => {
    if (input.sort === 'az') return byName(name(a), name(b));
    if (input.sort === 'newest') return b.createdAt.getTime() - a.createdAt.getTime();
    return Number(b.awaitingApproval) - Number(a.awaitingApproval) || b.createdAt.getTime() - a.createdAt.getTime();
  });
  return { page: sorted.slice(input.offset, input.offset + input.limit), total: sorted.length, letters, attention };
}
