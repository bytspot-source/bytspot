import { db } from '../lib/db';
import { sendGuestOfferEmail } from '../lib/email';
import { deliverPushNotification } from './notificationDelivery';

/**
 * Telling a guest an offer arrived.
 *
 * An offer is a hold with a deadline. A guest who is not told will usually
 * find out after it lapsed, and the seller — who made a real commitment
 * against real capacity — concludes nobody is on the other end. That is how a
 * two-sided rail dies before it starts, so this is part of offering rather
 * than a nicety layered on later.
 *
 * Delivery never fails the offer. The seller has already committed; refusing
 * their answer because a push could not be sent would punish the wrong party.
 */

/** Money as a guest reads it, so the notification says what it will cost. */
export function priceLabel(priceCents: number): string {
  if (priceCents <= 0) return 'No charge';
  const dollars = priceCents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** Whether a user left reservation emails on. On unless they turned it off. */
export function permitsReservationEmail(rawPreferences: unknown): boolean {
  if (!rawPreferences || typeof rawPreferences !== 'object' || Array.isArray(rawPreferences)) return true;
  const email = (rawPreferences as { email?: unknown }).email;
  if (!email || typeof email !== 'object' || Array.isArray(email)) return true;
  const value = (email as Record<string, unknown>).reservations;
  return typeof value === 'boolean' ? value : true;
}

/**
 * The time in the guest's own words, in the timezone the place actually keeps.
 * A table at "23:00Z" is not a sentence anyone reads.
 */
export function whenLabel(startsAt: Date, timeZone: string | null): string {
  try {
    if (!timeZone) throw new Error('no timezone');
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(startsAt);
  } catch {
    // A missing or unknown timezone is the seller's data problem, not a reason
    // to stay silent about a real offer.
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(startsAt);
  }
}

export async function notifyOfferArrived(offerId: string): Promise<void> {
  try {
    const offer = await db.offer.findUnique({
      where: { id: offerId },
      include: { demand: { select: { raisedByUserId: true } }, location: true },
    });
    if (!offer) return;

    const when = whenLabel(offer.startsAt, offer.location.timezone);
    const holdUntil = whenLabel(offer.holdExpiresAt, offer.location.timezone);
    // Both, not either: a guest without the app installed has no device to
    // push to, and one with it may have notifications off.
    await Promise.all([
      deliverPushNotification({
        userIds: [offer.demand.raisedByUserId],
        // A held table is a reservation, and the guest chose to hear about those.
        category: 'reservations',
        title: `${offer.location.label} can take you`,
        // Says the price and the time, because the decision is on a deadline and
        // a notification that only says "you have an offer" wastes the deadline.
        body: `${when} · ${priceLabel(offer.priceCents)}. Held until ${holdUntil}.`,
        // Every ask, from a Plan or a Discover card, is answered from My Requests.
        url: 'https://bytspot.app/requests',
        type: 'demand-offer',
      }),
      (async () => {
        const guest = await db.user.findUnique({
          where: { id: offer.demand.raisedByUserId },
          select: { email: true, name: true, notificationPrefs: true },
        });
        if (!guest?.email || !permitsReservationEmail(guest.notificationPrefs)) return;
        await sendGuestOfferEmail(guest.email, {
          where: offer.location.label,
          when,
          price: priceLabel(offer.priceCents),
          holdUntil,
          terms: offer.terms,
        });
      })(),
    ]);
  } catch {
    // Swallowed deliberately: see the note above about never failing the offer.
  }
}
