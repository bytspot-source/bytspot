/**
 * The outside booking sites a Bytspot admin may link a listed place to, and the
 * exact hosts each one's own pages live on. A link on any other host never
 * becomes a button. Pure data: shared by the API and BYTT-SI.
 *
 * The iOS app keeps the same table (NativeBookingProviders in
 * BytspotAPIClient.swift); keep the two in step.
 */
export const BOOKING_PROVIDERS = {
  opentable: { label: 'OpenTable', hosts: ['opentable.com', 'www.opentable.com'] },
  resy: { label: 'Resy', hosts: ['resy.com'] },
  tock: { label: 'Tock', hosts: ['exploretock.com', 'www.exploretock.com'] },
  sevenrooms: { label: 'SevenRooms', hosts: ['sevenrooms.com', 'www.sevenrooms.com'] },
  fareharbor: { label: 'FareHarbor', hosts: ['fareharbor.com'] },
  peek: { label: 'Peek', hosts: ['book.peek.com', 'peek.com', 'www.peek.com'] },
  xola: { label: 'Xola', hosts: ['checkout.xola.com', 'xola.com', 'www.xola.com'] },
  bookeo: { label: 'Bookeo', hosts: ['bookeo.com', 'www.bookeo.com'] },
  vagaro: { label: 'Vagaro', hosts: ['vagaro.com', 'www.vagaro.com'] },
  booksy: { label: 'Booksy', hosts: ['booksy.com'] },
  fresha: { label: 'Fresha', hosts: ['fresha.com', 'www.fresha.com'] },
  mindbody: { label: 'Mindbody', hosts: ['mindbodyonline.com', 'www.mindbodyonline.com', 'clients.mindbodyonline.com'] },
  eventbrite: { label: 'Eventbrite', hosts: ['eventbrite.com', 'www.eventbrite.com'] },
  dice: { label: 'DICE', hosts: ['dice.fm'] },
  parkwhiz: { label: 'ParkWhiz', hosts: ['parkwhiz.com', 'www.parkwhiz.com'] },
  spothero: { label: 'SpotHero', hosts: ['spothero.com'] },
  blade: { label: 'Blade', hosts: ['blade.com', 'www.blade.com'] },
  wheelsup: { label: 'Wheels Up', hosts: ['wheelsup.com', 'www.wheelsup.com'] },
} as const satisfies Record<string, { label: string; hosts: readonly string[] }>;

export type BookingProvider = keyof typeof BOOKING_PROVIDERS;
export const BOOKING_PROVIDER_IDS = Object.keys(BOOKING_PROVIDERS) as [BookingProvider, ...BookingProvider[]];

/** A link checked longer ago than this is hidden from guests until an admin checks it again. */
export const BOOKING_LINK_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export function isBookingProvider(value: string): value is BookingProvider {
  return Object.prototype.hasOwnProperty.call(BOOKING_PROVIDERS, value);
}

/** Why a link would put a broken or foreign button on a card, or null when it is fit. */
export function bookingUrlError(provider: string, url: string): string | null {
  if (!isBookingProvider(provider)) return 'Pick a booking provider.';
  const rule = BOOKING_PROVIDERS[provider];
  let parsed: URL | null = null;
  try { parsed = new URL(url.trim()); } catch { /* reported below */ }
  if (!parsed || parsed.protocol !== 'https:') return 'Paste the full https:// link.';
  if (!(rule.hosts as readonly string[]).includes(parsed.hostname)) return `That link is not on ${rule.hosts[0]}.`;
  return null;
}

/** An admin is asked to re-check a link this long before guests stop seeing it. */
export const BOOKING_LINK_REMIND_MS = 14 * 24 * 60 * 60 * 1000;

export type BookingLinkCheck = 'ok' | 'due_soon' | 'stale';

/** Where a link stands for the admin's re-check list: fine, due within 14 days, or already hidden from guests. */
export function bookingLinkCheck(checkedAt: Date | null | undefined, now = Date.now()): { status: BookingLinkCheck; dueAt: Date | null } {
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) return { status: 'stale', dueAt: null };
  const dueAt = new Date(checkedAt.getTime() + BOOKING_LINK_MAX_AGE_MS);
  if (now > dueAt.getTime()) return { status: 'stale', dueAt };
  return { status: dueAt.getTime() - now <= BOOKING_LINK_REMIND_MS ? 'due_soon' : 'ok', dueAt };
}

/** Whether a link checked at `checkedAt` may still be shown to guests. */
export function bookingLinkFresh(checkedAt: Date | null | undefined, now = Date.now()): boolean {
  return checkedAt instanceof Date && !Number.isNaN(checkedAt.getTime()) && now - checkedAt.getTime() <= BOOKING_LINK_MAX_AGE_MS;
}
