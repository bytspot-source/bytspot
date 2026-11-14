import { db } from '../lib/db';
import { BOOKING_PROVIDERS, bookingLinkCheck, bookingLinkExpired, isBookingProvider, type BookingLinkCheck } from './bookingProviders';

export interface BookingRecheckItem {
  venueId: string;
  name: string;
  provider: string;
  url: string;
  /** `expired`: the event is over; replace the link with the next event or remove it. */
  status: Exclude<BookingLinkCheck, 'ok'> | 'expired';
  /** When guests stop (or stopped) seeing the link. Null when it was never checked. */
  dueAt: Date | null;
}

/**
 * Listed places whose booking link is hidden from guests (not checked in 90
 * days, or the event it books is over) or will be within 14 days. Hidden ones first, then soonest due.
 * Hidden places (an admin pulled them) are left out: no guest sees them anyway.
 */
export async function bookingLinksToRecheck(now = new Date()): Promise<BookingRecheckItem[]> {
  const venues = await db.venue.findMany({
    where: { listedAt: { not: null }, discoverable: true, bookingUrl: { not: null } },
    select: { id: true, name: true, bookingProvider: true, bookingUrl: true, bookingCheckedAt: true, bookingExpiresAt: true },
    take: 1000,
  });
  const items: BookingRecheckItem[] = [];
  for (const venue of venues) {
    if (!venue.bookingUrl || !venue.bookingProvider) continue;
    const expired = bookingLinkExpired(venue.bookingExpiresAt, now.getTime());
    const check = expired ? { status: 'expired' as const, dueAt: venue.bookingExpiresAt } : bookingLinkCheck(venue.bookingCheckedAt, now.getTime());
    if (check.status === 'ok') continue;
    items.push({
      venueId: venue.id,
      name: venue.name,
      provider: isBookingProvider(venue.bookingProvider) ? BOOKING_PROVIDERS[venue.bookingProvider].label : venue.bookingProvider,
      url: venue.bookingUrl,
      status: check.status,
      dueAt: check.dueAt,
    });
  }
  return items.sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0) || a.name.localeCompare(b.name));
}
