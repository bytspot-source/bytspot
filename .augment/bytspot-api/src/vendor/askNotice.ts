import { db } from '../lib/db';
import { sendVendorAskEmail } from '../lib/email';
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
            seats: { select: { role: true, state: true, user: { select: { email: true } } } },
          },
        },
      },
    });
    if (!window) return;
    const to = askNoticeRecipients(
      window.seller.contactEmail,
      window.seller.seats.map((seat) => ({ role: seat.role, state: seat.state, email: seat.user.email })),
    );
    await sendVendorAskEmail(to, {
      title: skuTemplate(window.skuTemplateId)?.title ?? 'Your listing',
      placeLabel: window.location.label,
      partySize: ask.partySize,
      when: formatAskWhen(ask.startsAt, window.location.timezone),
      note: ask.note,
    });
  } catch (err: any) {
    console.error('[vendor] ask notice failed:', err?.message);
  }
}
