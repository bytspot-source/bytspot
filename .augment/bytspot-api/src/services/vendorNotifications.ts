import { db } from '../lib/db';

export const VENDOR_REQUEST_OPEN_STATUSES = ['REQUESTED', 'HOLD_AUTHORIZED', 'COUNTER_OFFERED'] as const;

export type VendorNotificationType =
  | 'NEW_REQUEST'
  | 'BOOKING_CONFIRMED'
  | 'EXPIRATION_WARNING'
  | 'DECLINED'
  | 'COUNTER_OFFER'
  | 'COMPLETED';

type VendorNotificationInput = {
  vendorId: string;
  bookingId?: string | null;
  recipientUserId?: string | null;
  type: VendorNotificationType | string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
};

function displayTier(tier: unknown): string {
  const value = String(tier ?? 'SIMPLE').toUpperCase();
  if (value === 'BLACK') return 'Black';
  if (value === 'PLATINUM') return 'Platinum';
  if (value === 'GREEN') return 'Green';
  return 'Provider';
}

export async function createVendorNotification(input: VendorNotificationInput) {
  return (db as any).vendorNotification.create({
    data: {
      vendorId: input.vendorId,
      bookingId: input.bookingId ?? null,
      recipientUserId: input.recipientUserId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      payload: input.payload ?? {},
    },
  });
}

export async function notifyVendorNewRequest(input: {
  vendorId: string;
  bookingId: string;
  serviceTitle: string;
  tier?: string | null;
  amountCents: number;
  currency: string;
  requestStatus: string;
  requestExpiresAt?: Date | null;
  secureHoldAuthorized?: boolean;
}) {
  const tierLabel = displayTier(input.tier);
  return createVendorNotification({
    vendorId: input.vendorId,
    bookingId: input.bookingId,
    type: 'NEW_REQUEST',
    title: `New ${tierLabel} request`,
    body: `${input.serviceTitle} is waiting for provider review.`,
    payload: {
      bookingId: input.bookingId,
      tier: input.tier ?? 'SIMPLE',
      amountCents: input.amountCents,
      currency: input.currency,
      requestStatus: input.requestStatus,
      requestExpiresAt: input.requestExpiresAt?.toISOString?.() ?? null,
      secureHoldAuthorized: Boolean(input.secureHoldAuthorized),
    },
  });
}

export async function getVendorUnreadNotificationCount(vendorId: string, type?: string): Promise<number> {
  return (db as any).vendorNotification.count({
    where: {
      vendorId,
      readAt: null,
      ...(type ? { type } : {}),
    },
  });
}

export async function expireVendorOpenRequests(input: {
  vendorId?: string;
  now?: Date;
} = {}) {
  const now = input.now ?? new Date();
  const where: any = {
    requestStatus: { in: [...VENDOR_REQUEST_OPEN_STATUSES] },
    requestExpiresAt: { lte: now },
  };
  if (input.vendorId) where.vendorId = input.vendorId;

  const result = await db.booking.updateMany({
    where,
    data: { requestStatus: 'EXPIRED' } as any,
  });
  return { checkedAt: now, expiredCount: result.count ?? 0 };
}

export async function createVendorExpirationWarnings(input: {
  vendorId?: string;
  now?: Date;
  warningWindowMinutes?: number;
  limit?: number;
} = {}) {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() + (input.warningWindowMinutes ?? 15) * 60_000);
  const where: any = {
    requestStatus: { in: [...VENDOR_REQUEST_OPEN_STATUSES] },
    requestExpiresAt: { gt: now, lte: cutoff },
  };
  if (input.vendorId) where.vendorId = input.vendorId;

  const bookings = await db.booking.findMany({
    where,
    orderBy: [{ requestExpiresAt: 'asc' }, { createdAt: 'desc' }] as any,
    take: input.limit ?? 100,
    select: {
      id: true,
      vendorId: true,
      tier: true,
      requestStatus: true,
      requestExpiresAt: true,
      priceCents: true,
      currency: true,
      service: { select: { title: true } },
    } as any,
  }) as any[];

  const notifications = [];
  for (const booking of bookings) {
    const existing = await (db as any).vendorNotification.findFirst({
      where: { vendorId: booking.vendorId, bookingId: booking.id, type: 'EXPIRATION_WARNING' },
    });
    if (existing) continue;
    notifications.push(await createVendorNotification({
      vendorId: booking.vendorId,
      bookingId: booking.id,
      type: 'EXPIRATION_WARNING',
      title: `${displayTier(booking.tier)} request expiring soon`,
      body: `${booking.service?.title ?? 'Request'} expires soon.`,
      payload: {
        bookingId: booking.id,
        tier: booking.tier ?? 'SIMPLE',
        requestStatus: booking.requestStatus,
        requestExpiresAt: booking.requestExpiresAt?.toISOString?.() ?? null,
        amountCents: booking.priceCents,
        currency: booking.currency,
      },
    }));
  }

  return { checked: bookings.length, warningsCreated: notifications.length, notifications };
}