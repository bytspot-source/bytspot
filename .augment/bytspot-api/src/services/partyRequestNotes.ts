import { z } from 'zod';

/** Upper bound a host can set on a single ticket tier. */
export const MAX_REQUEST_NOTES_PER_TICKET = 5;
export const REQUEST_NOTE_MAX_LENGTH = 140;
/** Accepted notes the stage screen rolls through, newest first. */
export const STAGE_SCREEN_LIMIT = 20;

export const requestNoteStatuses = ['sent', 'accepted', 'played', 'dismissed'] as const;
export type RequestNoteStatus = (typeof requestNoteStatuses)[number];
export type RequestNoteDecision = 'accept' | 'played' | 'dismiss';

// One line of plain text: no control, line-break or bidi-override characters,
// so a note reads on the stage screen exactly as the performer approved it.
export const requestNoteBody = z.string().trim().min(1).max(REQUEST_NOTE_MAX_LENGTH)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/, 'Keep the note to one line of text.');

type TierShape = { name?: unknown; priceCents?: unknown; requestNotes?: unknown };

function tierRequestNotes(tier: TierShape): number {
  const count = tier.requestNotes;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return 0;
  if (typeof tier.priceCents !== 'number' || tier.priceCents <= 0) return 0;
  return Math.min(count, MAX_REQUEST_NOTES_PER_TICKET);
}

/** Paid tiers that include requests, for the upgrade prompt. */
export function tiersWithRequests(ticketTiers: unknown): Array<{ name: string; priceCents: number; requestNotes: number }> {
  if (!Array.isArray(ticketTiers)) return [];
  return ticketTiers.flatMap((tier: TierShape) => {
    const requestNotes = tierRequestNotes(tier ?? {});
    return requestNotes > 0 && typeof tier.name === 'string' && typeof tier.priceCents === 'number'
      ? [{ name: tier.name, priceCents: tier.priceCents, requestNotes }] : [];
  });
}

/**
 * How many notes a guest's ticket includes. Only a ticket Stripe confirmed
 * (`ticketed` with access) counts: an RSVP, a host approval or a pending
 * checkout includes none, whatever tier name the row carries.
 */
export function requestAllowance(ticketTiers: unknown, guest: { status: string; accessGranted: boolean; ticketTierName: string | null } | null): number {
  if (!guest || guest.status !== 'ticketed' || !guest.accessGranted || !guest.ticketTierName) return 0;
  return tiersWithRequests(ticketTiers).find((tier) => tier.name === guest.ticketTierName)?.requestNotes ?? 0;
}

export type RequestWindowState = 'open' | 'not-started' | 'ended' | 'closed';

/** Notes can be sent only while the party is on. */
export function requestWindowState(party: { startsAt: Date; closedAt: Date | null }, closesAt: Date, now: Date): RequestWindowState {
  if (party.closedAt) return 'closed';
  if (now < party.startsAt) return 'not-started';
  if (now >= closesAt) return 'ended';
  return 'open';
}

const transitions: Record<RequestNoteDecision, { from: RequestNoteStatus[]; to: RequestNoteStatus }> = {
  accept: { from: ['sent'], to: 'accepted' },
  played: { from: ['accepted'], to: 'played' },
  dismiss: { from: ['sent', 'accepted', 'played'], to: 'dismissed' },
};

export function requestNoteTransition(decision: RequestNoteDecision) {
  return transitions[decision];
}

/** First word of the account name, or null. Never the full name or email. */
export function senderFirstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0]?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '') ?? '';
  return first ? first.slice(0, 40) : null;
}
