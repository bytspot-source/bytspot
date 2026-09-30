import type { VendorSeller } from '@prisma/client';
import { db } from '../lib/db';
import { stripeHandle } from './payout';
import { windowTemplate } from './windows';

/**
 * Analytics and Payouts, read from what the demand rail already records.
 *
 * Nothing here is stored. DemandEvent is append-only and written on every
 * broadcast, offer, decline and accept, so the numbers are recomputed from it
 * on each read and can never disagree with the feed a vendor worked from.
 */

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export interface AnalyticsEvent {
  kind: string;
}

export interface AnalyticsOffer {
  windowId: string | null;
  title: string;
  state: string;
  priceCents: number;
  payAt: string;
}

export interface AnalyticsCheckout {
  status: string;
  amountCents: number;
  sellerNetCents: number;
}

export interface AnalyticsSummary {
  days: number;
  requests: number;
  offers: number;
  declined: number;
  booked: number;
  /** Booked out of offers sent, as a whole percent. Null before any offer. */
  winRate: number | null;
  /** Paid in the app: what guests paid, and what the business receives. */
  paidCents: number;
  netCents: number;
  refunds: number;
  /** Booked to be paid at the venue, at the offered price. */
  payAtVenueCents: number;
  top: { windowId: string; title: string; booked: number; valueCents: number }[];
}

export function summarizeAnalytics(input: {
  days: number;
  events: AnalyticsEvent[];
  offers: AnalyticsOffer[];
  checkouts: AnalyticsCheckout[];
}): AnalyticsSummary {
  const count = (kind: string) => input.events.filter((event) => event.kind === kind).length;
  const offers = count('OFFERED');
  const booked = count('ACCEPTED');
  const completed = input.checkouts.filter((checkout) => checkout.status === 'completed');

  const accepted = input.offers.filter((offer) => offer.state === 'ACCEPTED');
  const byWindow = new Map<string, { windowId: string; title: string; booked: number; valueCents: number }>();
  for (const offer of accepted) {
    if (!offer.windowId) continue;
    const row = byWindow.get(offer.windowId) ?? { windowId: offer.windowId, title: offer.title, booked: 0, valueCents: 0 };
    row.booked += 1;
    row.valueCents += offer.priceCents;
    byWindow.set(offer.windowId, row);
  }

  return {
    days: input.days,
    requests: count('BROADCAST'),
    offers,
    declined: count('DECLINED'),
    booked,
    winRate: offers ? Math.round((Math.min(booked, offers) / offers) * 100) : null,
    paidCents: completed.reduce((total, checkout) => total + checkout.amountCents, 0),
    netCents: completed.reduce((total, checkout) => total + checkout.sellerNetCents, 0),
    refunds: input.checkouts.filter((checkout) => checkout.status === 'refunded').length,
    payAtVenueCents: accepted.filter((offer) => offer.payAt === 'venue').reduce((total, offer) => total + offer.priceCents, 0),
    top: [...byWindow.values()].sort((a, b) => b.booked - a.booked || b.valueCents - a.valueCents).slice(0, 5),
  };
}

export function analyticsRange(raw: unknown): AnalyticsRange {
  const days = Number(raw);
  return (ANALYTICS_RANGES as readonly number[]).includes(days) ? (days as AnalyticsRange) : 30;
}

function titleFor(window: { skuTemplateId: string; title: string | null; durationMins: number | null } | null, fallback: string): string {
  return (window && windowTemplate(window)?.title) || fallback;
}

export async function loadAnalytics(sellerId: string, days: AnalyticsRange, now: Date = new Date()): Promise<AnalyticsSummary> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [events, offers, checkouts] = await Promise.all([
    db.demandEvent.findMany({ where: { sellerId, occurredAt: { gte: since } }, select: { kind: true } }),
    db.offer.findMany({
      where: { sellerId, state: 'ACCEPTED', updatedAt: { gte: since } },
      select: {
        windowId: true,
        skuTemplateId: true,
        state: true,
        priceCents: true,
        payAt: true,
        window: { select: { skuTemplateId: true, title: true, durationMins: true } },
      },
    }),
    db.offerCheckout.findMany({
      where: { sellerId, createdAt: { gte: since }, status: { in: ['completed', 'refunded'] } },
      select: { status: true, amountCents: true, sellerNetCents: true },
    }),
  ]);
  return summarizeAnalytics({
    days,
    events,
    offers: offers.map((offer) => ({
      windowId: offer.windowId,
      title: titleFor(offer.window, offer.skuTemplateId),
      state: offer.state,
      priceCents: offer.priceCents,
      payAt: offer.payAt,
    })),
    checkouts,
  });
}

export interface PayoutLineDto {
  id: string;
  title: string;
  paidAt: string;
  status: 'completed' | 'refunded';
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency: string;
  refundReason?: string;
}

export interface PayoutTotals {
  netCents: number;
  feeCents: number;
  bookings: number;
  refunds: number;
}

export function payoutTotals(lines: Pick<PayoutLineDto, 'status' | 'netCents' | 'feeCents'>[]): PayoutTotals {
  const completed = lines.filter((line) => line.status === 'completed');
  return {
    netCents: completed.reduce((total, line) => total + line.netCents, 0),
    feeCents: completed.reduce((total, line) => total + line.feeCents, 0),
    bookings: completed.length,
    refunds: lines.length - completed.length,
  };
}

/** Paid and refunded bookings, newest first. Pending checkouts are not money yet. */
export async function payoutLines(sellerId: string, limit = 50): Promise<PayoutLineDto[]> {
  const rows = await db.offerCheckout.findMany({
    where: { sellerId, status: { in: ['completed', 'refunded'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      offer: {
        select: { skuTemplateId: true, window: { select: { skuTemplateId: true, title: true, durationMins: true } } },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    title: titleFor(row.offer.window, row.offer.skuTemplateId),
    paidAt: (row.completedAt ?? row.createdAt).toISOString(),
    status: row.status === 'refunded' ? 'refunded' : 'completed',
    amountCents: row.amountCents,
    feeCents: row.platformFeeCents,
    netCents: row.sellerNetCents,
    currency: row.currency,
    refundReason: row.refundReason ?? undefined,
  }));
}

/**
 * A one-time link into the processor's own dashboard, where the vendor sees
 * balances and bank transfers. Minted per request because it expires quickly.
 */
export async function payoutDashboardLink(seller: VendorSeller): Promise<string | undefined> {
  const stripe = stripeHandle.client();
  if (!stripe || !seller.payoutReference || seller.payoutStatus !== 'active') return undefined;
  const link = await stripe.accounts.createLoginLink(seller.payoutReference);
  return link.url;
}
