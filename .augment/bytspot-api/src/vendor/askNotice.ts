import { db } from '../lib/db';
import { sendVendorAskEmail } from '../lib/email';
import { deliverPushNotification } from '../services/notificationDelivery';
import { skuTemplate } from './windows';

/** The seller's contact address if it set one; otherwise every live owner and manager. */
export function askNoticeRecipients(
  contactEmail: string | null,
  seats: { role: string; state: string; email: string }[],
): string[] {
  if (contactEmail?.trim()) return [contactEmail.trim()];
  const emails = seats
    .filter((seat) => seat.state === 'ACTIVE' && (seat.role === 'owner' || seat.role === 'manager'))
    .map((seat) => seat.email);
  return [...new Set(emails)];
}

/** Who among a seller's seats can answer an ask: its live owners and managers. */
export function askNoticeSeatUserIds(seats: { role: string; state: string; userId: string }[]): string[] {
  const ids = seats
    .filter((seat) => seat.state === 'ACTIVE' && (seat.role === 'owner' || seat.role === 'manager'))
    .map((seat) => seat.userId);
  return [...new Set(ids)];
}

/** The slot in the place's own clock, which is the one the seller reads. */
export function formatAskWhen(startsAt: Date, timeZone: string | null): string {
  return startsAt.toLocaleString('en-US', {
    timeZone: timeZone ?? 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? {} : { timeZoneName: 'short' }),
  });
}

/** Tell a seller a guest asked one of their windows. Never throws. */
export async function notifyAskSeller(
  windowId: string,
  ask: { partySize: number; startsAt: Date; note?: string | null },
): Promise<void> {
  try {
    const window = await db.vendorAvailabilityWindow.findUnique({
      where: { id: windowId },
      select: {
        skuTemplateId: true,
        location: { select: { label: true, timezone: true } },
        seller: {
          select: {
            contactEmail: true,
            seats: { select: { role: true, state: true, userId: true, user: { select: { email: true } } } },
          },
        },
      },
    });
    if (!window) return;
    const to = askNoticeRecipients(
      window.seller.contactEmail,
      window.seller.seats.map((seat) => ({ role: seat.role, state: seat.state, email: seat.user.email })),
    );
    const title = skuTemplate(window.skuTemplateId)?.title ?? 'Your listing';
    const when = formatAskWhen(ask.startsAt, window.location.timezone);
    const guests = `${ask.partySize} ${ask.partySize === 1 ? 'guest' : 'guests'}`;
    await Promise.all([
      sendVendorAskEmail(to, { title, placeLabel: window.location.label, partySize: ask.partySize, when, note: ask.note }),
      // A seat is a Bytspot account, so an owner with the app installed hears
      // about it on their phone as well as in their inbox.
      deliverPushNotification({
        userIds: askNoticeSeatUserIds(window.seller.seats),
        category: 'reservations',
        title: `New request at ${window.location.label}`,
        body: `${guests}, ${when} · ${title}. Answer it in your business console.`,
        url: 'https://bytspot.app/discover',
        type: 'vendor-ask',
      }),
    ]);
  } catch (err: any) {
    console.error('[vendor] ask notice failed:', err?.message);
  }
}
