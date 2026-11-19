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
  airbnb: { label: 'Airbnb', hosts: ['airbnb.com', 'www.airbnb.com'] },
  hipcamp: { label: 'Hipcamp', hosts: ['hipcamp.com', 'www.hipcamp.com'] },
  bookingcom: { label: 'Booking.com', hosts: ['booking.com', 'www.booking.com'] },
  bookretreats: { label: 'BookRetreats', hosts: ['bookretreats.com', 'www.bookretreats.com'] },
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
  const share = SHARE_HOSTS[parsed.hostname];
  if (share) return `That is a ${share} share link. Open it in a browser and copy the full ${rule.hosts[0]} address from the address bar.`;
  if (!(rule.hosts as readonly string[]).includes(parsed.hostname)) return `That link is not on ${rule.hosts[0]}.`;
  if (url.trim().length > BOOKING_URL_MAX) return `That link is too long (over ${BOOKING_URL_MAX} characters). Open the place's own page and copy that address.`;
  return null;
}

/** The longest link kept after cleaning. Search and share links can run to thousands of characters. */
export const BOOKING_URL_MAX = 1000;
/** The longest link an admin may paste before cleaning. */
export const BOOKING_URL_PASTE_MAX = 8000;

/** A stay listing opens without its search state, and its query is mostly dates and tracking. */
const PATH_ONLY_PROVIDERS = new Set<string>(['airbnb', 'hipcamp', 'bookingcom', 'bookretreats']);
/** Share, ad and search-session keys that never change which page a link opens. */
const TRACKING_KEY = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|msclkid|mc_[a-z]+|_ga|_gl|ref|ref_|referrer|source|source_impression_id|previous_page_section_name|federated_search_id|search_mode|s|unique_share_id|sid|srpvid|srepoch|ucfs|arphpl|dest_id|dest_type|hapos|hpos|sr_order|sb_price_type|all_sr_blocks|highlighted_blocks|matching_block_id|aid|label)$/i;

/** Short share hosts that hide the real page. They are refused with a way to find the full link. */
const SHARE_HOSTS: Record<string, string> = {
  'abnb.me': 'Airbnb', 'airbnb.app.link': 'Airbnb', 'booking.page.link': 'Booking.com',
};

/**
 * The link to store: share, ad and search tracking removed, and for a stay
 * (Airbnb, Hipcamp, Booking.com, BookRetreats) only the listing's own page.
 * Returns the input unchanged when it is not a URL, so bookingUrlError reports it.
 */
export function cleanBookingUrl(provider: string, url: string): string {
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return url.trim(); }
  parsed.hash = '';
  if (PATH_ONLY_PROVIDERS.has(provider)) {
    parsed.search = '';
  } else {
    for (const key of [...parsed.searchParams.keys()]) if (TRACKING_KEY.test(key)) parsed.searchParams.delete(key);
  }
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/') && PATH_ONLY_PROVIDERS.has(provider)) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
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

/**
 * Flights and charters. Their links are for getting to another city, so guests
 * never see them on a place; they are offered only with a Plan or search for a
 * city far from the guest (Concierge "Getting there").
 */
export const AVIATION_BOOKING_PROVIDERS: readonly BookingProvider[] = ['blade', 'wheelsup'];

export function isAviationProvider(value: string | null | undefined): boolean {
  return typeof value === 'string' && (AVIATION_BOOKING_PROVIDERS as readonly string[]).includes(value);
}

/** Providers whose links are usually for one event, so the admin is asked for the event's date. */
export const EVENT_BOOKING_PROVIDERS: readonly BookingProvider[] = ['eventbrite', 'dice'];

/** The latest end an admin may set: two years out. */
export const BOOKING_EXPIRY_MAX_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Whether an event link's end has passed. No end never expires. */
export function bookingLinkExpired(expiresAt: Date | null | undefined, now = Date.now()): boolean {
  return expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now;
}

/** Whether a link checked at `checkedAt` may still be shown to guests. */
export function bookingLinkFresh(checkedAt: Date | null | undefined, now = Date.now()): boolean {
  return checkedAt instanceof Date && !Number.isNaN(checkedAt.getTime()) && now - checkedAt.getTime() <= BOOKING_LINK_MAX_AGE_MS;
}
