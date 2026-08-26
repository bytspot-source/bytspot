/**
 * Party Alerts
 *
 * The party leg of the alert spine. Unlike crowd alerts, these events are not
 * inferred from occupancy: a guest really did RSVP, a host really did decide.
 * There is nothing to estimate and nothing to label Typical, so the honesty
 * rules that govern venue alerts do not apply here.
 *
 * Every send resolves its recipient through `partyAlertRecipient` rather than
 * addressing a user id inline. Party alerts have exactly two legitimate
 * audiences — the host of that Party, and one named guest holding a pass to
 * it — and routing all three producers through one resolver is what stops a
 * fourth producer from quietly inventing a third audience.
 */

import { db } from '../lib/db';
import { deliverPushNotification } from './notificationDelivery';
import type { NotificationDeliveryResult } from './notificationDelivery';
import { config } from '../config';

export type PartyAlertAudience =
  | { kind: 'host'; partyId: string }
  | { kind: 'guest'; partyId: string; userId: string };

const NO_DELIVERY: NotificationDeliveryResult = {
  targetedUsers: 0, devices: 0, sent: 0, skipped: 0, permanentFailures: 0, temporaryFailures: 0,
};

export function partyAlertUrl(partyId: string): string {
  return `${config.partyShareBaseUrl}/party/${encodeURIComponent(partyId)}`;
}

/**
 * Resolves an audience to the single user id that may receive this alert, or
 * null when nobody is eligible. A guest is eligible only while holding access
 * to that Party: a declined or withdrawn guest stops being addressable, so a
 * later alert cannot reach someone the host has already turned away.
 */
export async function partyAlertRecipient(audience: PartyAlertAudience): Promise<string | null> {
  const party = await db.party.findUnique({
    where: { id: audience.partyId },
    select: { hostUserId: true, status: true },
  });
  // A Party that is not published is not addressable by either audience: an
  // unpublished or withdrawn Party must not be able to notify anyone.
  if (!party || party.status !== 'published') return null;
  if (audience.kind === 'host') return party.hostUserId;

  const guest = await db.partyGuest.findUnique({
    where: { partyId_userId: { partyId: audience.partyId, userId: audience.userId } },
    select: { userId: true },
  });
  // Membership of the guest list is the whole eligibility test: a declined
  // guest is still owed the decision that declined them, and someone with no
  // row on this Party is never addressable.
  return guest?.userId ?? null;
}

async function send(input: {
  audience: PartyAlertAudience;
  title: string;
  body: string;
  type: string;
}): Promise<NotificationDeliveryResult> {
  const userId = await partyAlertRecipient(input.audience);
  if (!userId) return NO_DELIVERY;

  return deliverPushNotification({
    userIds: [userId],
    category: 'party',
    title: input.title,
    body: input.body,
    url: partyAlertUrl(input.audience.partyId),
    type: input.type,
  });
}

/**
 * Looks up a display name for alert copy. Every failure degrades to the
 * generic form: enriching a notification must never be able to fail the
 * mutation that earned it, and the alert is worth more than the name.
 */
async function displayName(userId: string): Promise<string | null> {
  try {
    const member = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
    return member?.name ?? null;
  } catch {
    return null;
  }
}

/** A guest asked to come. Reaches the host only. */
export async function alertHostOfGuestResponse(input: {
  partyId: string;
  guestUserId: string;
  approvalRequired: boolean;
}): Promise<NotificationDeliveryResult> {
  const who = (await displayName(input.guestUserId))?.trim() || 'A Bytspot member';
  return send({
    audience: { kind: 'host', partyId: input.partyId },
    title: input.approvalRequired ? 'New Party request' : 'Someone is coming',
    body: input.approvalRequired ? `${who} asked to join your Party.` : `${who} is on the list.`,
    type: 'party.rsvp',
  });
}

/** The host decided. Reaches that one guest, approved or declined. */
export async function alertGuestOfDecision(input: {
  partyId: string;
  guestUserId: string;
  partyTitle: string | null;
  decision: 'approved' | 'declined';
}): Promise<NotificationDeliveryResult> {
  const title = input.partyTitle?.trim() || 'the Party';
  return send({
    audience: { kind: 'guest', partyId: input.partyId, userId: input.guestUserId },
    title: input.decision === 'approved' ? "You're in" : 'Party request declined',
    body: input.decision === 'approved'
      ? `The host confirmed your pass to ${title}.`
      : `The host declined your request to ${title}.`,
    type: `party.decision.${input.decision}`,
  });
}

/** A guest was admitted at the door. Reaches the host only. */
export async function alertHostOfDoorArrival(input: {
  partyId: string;
  guestName: string | null;
}): Promise<NotificationDeliveryResult> {
  const who = input.guestName?.trim() || 'A guest';
  return send({
    audience: { kind: 'host', partyId: input.partyId },
    title: 'Arrived',
    body: `${who} just walked in.`,
    type: 'party.arrival',
  });
}

/**
 * Tells a host that someone from one of their own circles just bought a ticket,
 * so they can follow up. Deliberately says nothing a guest could not already
 * see: it names the buyer to the host only, and never restates the venue, which
 * for an after-approval or withheld Party stays hidden from unapproved guests.
 *
 * Fires only when the buyer is actually in a circle the host owns AND that the
 * Party was addressed to — a public buyer is not a social-graph signal.
 */
export async function alertHostOfCircleTicketPurchase(input: {
  partyId: string;
  buyerUserId: string;
}): Promise<NotificationDeliveryResult | null> {
  const party = await db.party.findUnique({
    where: { id: input.partyId },
    select: { hostUserId: true, audienceCircleIds: true },
  });
  if (!party || party.audienceCircleIds.length === 0 || party.hostUserId === input.buyerUserId) return null;

  const membership = await db.socialCircleMember.findFirst({
    where: {
      userId: input.buyerUserId,
      circleId: { in: party.audienceCircleIds },
      circle: { ownerId: party.hostUserId },
    },
    select: { id: true },
  });
  if (!membership) return null;

  const who = (await displayName(input.buyerUserId))?.trim() || 'A member of your circle';
  return send({
    audience: { kind: 'host', partyId: input.partyId },
    title: 'Someone from your circle is in',
    body: `${who} bought a ticket to your Party.`,
    type: 'party.rsvp',
  });
}

/**
 * Party alerts are a courtesy on top of a completed mutation. A push failure
 * must never turn a successful RSVP into an error for the member who made it.
 */
export function dispatchPartyAlert(work: Promise<unknown>): void {
  void work.catch(() => {});
}
