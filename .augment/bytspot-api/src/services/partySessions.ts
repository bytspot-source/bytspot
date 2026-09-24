/**
 * Bottles and a stretch of time, sold as one unit.
 *
 * A session is supply, not part of a Party's floor plan. A vendor creates it;
 * a host attaches it to a Party so the people already coming can buy it. The
 * Party is the audience and the sales channel, never the container — which is
 * why nothing here fences a session inside the Party's hours or address.
 *
 * Three rules that used to live in this file are deliberately gone:
 *
 *   - seats, and their sum against the Party's capacity. A club sells a table
 *     by its bottles. Comparing bottle counts to how many people the room
 *     holds rejected correct floors as overselling.
 *   - a ceiling at the Party's end. An after-hours session runs past it by
 *     definition, so that rule refused the product outright.
 *   - a floor at the Party's start, for the same reason in the other
 *     direction.
 *
 * Validation is a pure function over the vendor's draft so the seller is told
 * which session is wrong instead of meeting a database constraint violation.
 * The database holds the same rules — these are the readable half of a pair,
 * never the only guard.
 */

/** `included` — the price is the whole number, bottles are in it.
 *  `minimum`  — the price is the fee and bottles are bought on top, so the
 *  guest will pay more than the number and has to be told so. */
export type BottleTerms = 'included' | 'minimum';

export type SessionKind = 'table' | 'after-hours';

export interface SessionDraft {
  name: string;
  kind: SessionKind;
  startsAt: Date;
  endsAt: Date;
  /// Null means the Party's address. Stated means somewhere else, which is
  /// the ordinary case for an after-hours session.
  venueName?: string | null;
  lat?: number | null;
  lng?: number | null;
  bottleCount: number;
  bottleTerms: BottleTerms;
  priceCents: number;
  quantity: number;
  requiredMembershipTier?: string | null;
}

export interface SessionIssue {
  index: number | null;
  field: string;
  message: string;
}

/**
 * Every complaint at once, indexed to the session that caused it, so a seller
 * fixing a four-session evening is not told about one problem per attempt.
 * `index` is null for a complaint about the set rather than a member.
 */
export function validateSessions(sessions: SessionDraft[]): SessionIssue[] {
  const issues: SessionIssue[] = [];
  if (sessions.length === 0) return issues;

  sessions.forEach((session, index) => {
    if (session.endsAt.getTime() <= session.startsAt.getTime()) {
      issues.push({ index, field: 'endsAt', message: 'A session must end after it starts.' });
    }
    if (session.quantity <= 0) {
      issues.push({ index, field: 'quantity', message: 'A session nobody can buy is not for sale.' });
    }
    if (session.bottleCount < 0) {
      issues.push({ index, field: 'bottleCount', message: 'A session cannot include fewer than no bottles.' });
    }
    // Zero bottles under `minimum` is a minimum of nothing, which is not a
    // minimum. Under `included` it is a table with no bottles, which a vendor
    // may legitimately sell.
    if (session.bottleTerms === 'minimum' && session.bottleCount === 0) {
      issues.push({ index, field: 'bottleCount', message: 'A bottle minimum of zero bottles states no minimum.' });
    }
    if (session.priceCents < 0) {
      issues.push({ index, field: 'priceCents', message: 'A session cannot cost less than nothing.' });
    }
    // A place is stated completely or not at all: half an address cannot be
    // put on a map, and a session away from the Party is only useful if a
    // guest can be told where to go.
    if ((session.lat == null) !== (session.lng == null)) {
      issues.push({ index, field: 'lat', message: 'A session states both coordinates or neither.' });
    }
    if (session.venueName != null && session.venueName.trim().length === 0) {
      issues.push({ index, field: 'venueName', message: 'A session held somewhere else needs that place named.' });
    }
    if (session.name.trim().length === 0) {
      issues.push({ index, field: 'name', message: 'A session needs a name the guest can recognise.' });
    }
  });

  // Two sessions called the same thing are indistinguishable on a pass.
  const seen = new Set<string>();
  sessions.forEach((session, index) => {
    const key = session.name.trim().toLowerCase();
    if (key.length === 0) return;
    if (seen.has(key)) {
      issues.push({ index, field: 'name', message: 'Two sessions cannot share a name.' });
    } else {
      seen.add(key);
    }
  });

  return issues;
}

/**
 * What a guest is allowed to see about whether a session is still takeable.
 *
 * `full` and `passed` are different facts and are never collapsed: one says
 * come back for the next one, the other says this already happened.
 */
export type SessionState = 'open' | 'full' | 'passed';

/**
 * State told about units that already account for payments in flight. State
 * and units are derived from one number so a session cannot read `open` while
 * saying nothing is left.
 */
export function sessionState(
  session: { startsAt: Date },
  remaining: number,
  now: Date = new Date(),
): SessionState {
  if (session.startsAt.getTime() <= now.getTime()) return 'passed';
  return remaining === 0 ? 'full' : 'open';
}

/**
 * The claim rule checkout enforces, written once so the number a guest reads
 * and the number the till applies cannot drift apart.
 *
 * A unit is claimed when it is settled or when a payment for it is still in
 * flight. Counting only settled units would show a guest room that checkout
 * then refuses, which is a promise the till does not keep.
 */
export function liveClaimWhere(partyId: string, now: Date) {
  return {
    partyId,
    OR: [
      { status: 'completed' },
      { status: { in: ['creating', 'pending'] }, reservationExpiresAt: { gt: now } },
    ],
  };
}

/**
 * The same rule, narrowed to checkouts that buy the door.
 *
 * Party capacity counts people in the room, and a session checkout admits
 * nobody: it is sold to a guest who is already inside. Counting every
 * checkout meant bottles filled the room — enough table sales and the door
 * reported itself sold out while nobody had walked through it, and the guest
 * standing inside was refused the table for occupying a space they already
 * held.
 */
export function liveGateClaimWhere(partyId: string, now: Date) {
  return { ...liveClaimWhere(partyId, now), ticketTierName: { not: null } };
}

/**
 * Units left once payments in flight are counted.
 *
 * The two counts overlap rather than add: a settled checkout is both a
 * committed unit and a completed row, so summing them would take the same
 * unit twice. The larger is taken instead, which also covers a unit committed
 * without a checkout behind it, such as one the vendor gave away.
 */
export function liveRemaining(session: { quantity: number; committed: number }, holds: number): number {
  return Math.max(0, session.quantity - Math.max(session.committed, holds));
}

/**
 * What a card may claim about a Party's cheapest session, and under which
 * terms it claimed it.
 *
 * The number alone cannot be shown. A `$900 included` session really costs
 * $900; a `$200 minimum` session never costs $200, because bottles are bought
 * on top. Collapsing both into one integer would quote a number no guest can
 * pay, which is the same failure as a free door hiding a priced table.
 */
export interface SessionPriceFloor {
  fromCents: number;
  terms: BottleTerms;
}

/**
 * The cheapest session a guest could still take, per Party, kept with its
 * terms.
 *
 * Floors are compared within a shape and never across one: `minimum` prices
 * are not comparable with `included` prices, so an all-in price is preferred
 * whenever a Party has one. A `minimum` floor is only claimed when that is all
 * the Party sells, and then the card has to say the bottles are extra.
 */
export function sessionPriceFloors(
  sessions: { partyId: string; priceCents: number; bottleTerms: BottleTerms }[],
): Map<string, SessionPriceFloor> {
  const floors = new Map<string, SessionPriceFloor>();
  for (const session of sessions) {
    const current = floors.get(session.partyId);
    if (current === undefined) {
      floors.set(session.partyId, { fromCents: session.priceCents, terms: session.bottleTerms });
      continue;
    }
    // An all-in price displaces a minimum whatever the numbers say: a
    // complete price is worth more to a guest than a smaller incomplete one.
    if (current.terms === 'minimum' && session.bottleTerms === 'included') {
      floors.set(session.partyId, { fromCents: session.priceCents, terms: 'included' });
      continue;
    }
    if (current.terms === 'included' && session.bottleTerms === 'minimum') continue;
    if (session.priceCents < current.fromCents) {
      floors.set(session.partyId, { fromCents: session.priceCents, terms: session.bottleTerms });
    }
  }
  return floors;
}
