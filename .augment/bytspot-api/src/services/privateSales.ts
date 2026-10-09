import { db } from '../lib/db';
import { isMembershipTier, type MembershipTier } from '../lib/membershipTier';

/**
 * Private sales: a seller shares an item with chosen buyers, an expiring meet
 * point and their own payment handle. Bytspot shows the handle and opens the
 * provider; it never holds, moves or protects money.
 */

export const PAYMENT_PROVIDERS = ['paypal', 'cashapp', 'venmo'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const MAX_BUYERS_PER_SALE = 5;

/** Per membership. `openSales: null` is unlimited. */
export const SALE_LIMITS: Record<MembershipTier, { openSales: number | null; buyersPerSale: number }> = {
  green: { openSales: 1, buyersPerSale: 1 },
  platinum: { openSales: 5, buyersPerSale: 3 },
  black: { openSales: null, buyersPerSale: MAX_BUYERS_PER_SALE },
};

export function saleLimits(membershipTier: unknown) {
  const tier: MembershipTier = isMembershipTier(membershipTier) ? membershipTier : 'green';
  return { tier, ...SALE_LIMITS[tier] };
}
export const MAX_WINDOW_MS = 4 * 60 * 60 * 1000;
export const MAX_WINDOW_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** A meet point outlives its sale by this long, then is cleared. */
export const MEET_POINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** About 30 m of latitude. */
const MEET_GRID_DEGREES = 0.00027;
const START_GRACE_MS = 5 * 60 * 1000;

/** One message for missing, expired, sold, cancelled and not-yours alike. */
export const SALE_UNAVAILABLE = 'This sale is not available.';

const HANDLE_PATTERNS: Record<PaymentProvider, RegExp> = {
  paypal: /^[A-Za-z0-9]{1,20}$/,
  cashapp: /^(?=.*[A-Za-z])[A-Za-z0-9_]{1,20}$/,
  venmo: /^[A-Za-z0-9_-]{5,30}$/,
};

const HANDLE_PREFIXES: Record<PaymentProvider, RegExp> = {
  paypal: /^(?:https?:\/\/)?(?:www\.)?paypal\.me\//i,
  cashapp: /^(?:https?:\/\/)?(?:www\.)?cash\.app\/\$?|^\$/i,
  venmo: /^(?:https?:\/\/)?(?:www\.|account\.)?venmo\.com\/(?:u\/)?|^@/i,
};

/** The handle as stored, or null when it is not one the provider would issue. */
export function normalizeHandle(provider: PaymentProvider, raw: string): string | null {
  const handle = raw.trim().replace(HANDLE_PREFIXES[provider], '').replace(/[/?#].*$/, '');
  return HANDLE_PATTERNS[provider].test(handle) ? handle : null;
}

export function handleUrl(provider: PaymentProvider, handle: string): string {
  if (provider === 'paypal') return `https://paypal.me/${handle}`;
  if (provider === 'cashapp') return `https://cash.app/$${handle}`;
  return `https://venmo.com/u/${handle}`;
}

/** What the buyer reads under each pay button. Pending legal review. */
export function paymentReminder(provider: PaymentProvider): string {
  if (provider === 'cashapp') {
    return 'Cash App payments between people have no purchase protection. Bytspot doesn\'t process or protect this payment.';
  }
  return 'Pay as Goods and Services where available. Bytspot doesn\'t process or protect this payment.';
}

export function snapMeetPoint(lat: number, lng: number): { lat: number; lng: number } {
  const snap = (value: number) => Number((Math.round(value / MEET_GRID_DEGREES) * MEET_GRID_DEGREES).toFixed(6));
  return { lat: snap(lat), lng: snap(lng) };
}

/** Why a meet window is refused, or null when it is acceptable. */
export function meetWindowProblem(start: Date, end: Date, now = new Date()): string | null {
  if (start.getTime() < now.getTime() - START_GRACE_MS) return 'The meet window has to start in the future.';
  if (start.getTime() - now.getTime() > MAX_WINDOW_LEAD_MS) return 'The meet window has to start within 7 days.';
  if (end.getTime() <= start.getTime()) return 'The meet window has to end after it starts.';
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) return 'The meet window can be at most 4 hours long.';
  return null;
}

export type SaleState = 'open' | 'ended' | 'sold' | 'cancelled';

export function saleState(sale: { status: string; windowEnd: Date }, now = new Date()): SaleState {
  if (sale.status === 'sold' || sale.status === 'cancelled') return sale.status;
  return sale.windowEnd.getTime() <= now.getTime() ? 'ended' : 'open';
}

/** Clears the meet point of every sale closed or ended more than 7 days ago. */
export async function scrubClosedSaleMeetPoints(now = new Date()): Promise<{ scrubbed: number }> {
  const cutoff = new Date(now.getTime() - MEET_POINT_RETENTION_MS);
  const { count } = await db.privateSale.updateMany({
    where: {
      meetScrubbedAt: null,
      OR: [{ closedAt: { lte: cutoff } }, { status: 'open', windowEnd: { lte: cutoff } }],
    },
    data: { meetLat: null, meetLng: null, meetPlaceName: null, meetScrubbedAt: now },
  });
  return { scrubbed: count };
}
