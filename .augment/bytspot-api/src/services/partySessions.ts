/**
 * Sittings inside a Party.
 *
 * Validation is a pure function over the host's draft and the Party it belongs
 * to, so the host is told which sitting is wrong instead of meeting a database
 * constraint violation. The database still holds the same rules — these are the
 * readable half of a pair, never the only guard.
 */

export interface SessionDraft {
  name: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  priceCents: number;
  requiredMembershipTier?: string | null;
}

export interface SessionHostParty {
  startsAt: Date;
  /// Null when the host never stated an end, in which case a sitting has a
  /// floor but no ceiling — an unstated end is unknown, not midnight.
  endsAt: Date | null;
  capacity: number;
  accessMode: string;
}

export interface SessionIssue {
  index: number | null;
  field: string;
  message: string;
}

/**
 * Every complaint at once, indexed to the sitting that caused it, so a host
 * fixing a four-sitting evening is not told about one problem per attempt.
 * `index` is null for a complaint about the set rather than a member.
 */
export function validateSessions(sessions: SessionDraft[], party: SessionHostParty): SessionIssue[] {
  const issues: SessionIssue[] = [];
  if (sessions.length === 0) return issues;

  sessions.forEach((session, index) => {
    if (session.endsAt.getTime() <= session.startsAt.getTime()) {
      issues.push({ index, field: 'endsAt', message: 'A sitting must end after it starts.' });
    }
    if (session.startsAt.getTime() < party.startsAt.getTime()) {
      issues.push({ index, field: 'startsAt', message: 'A sitting cannot start before the Party does.' });
    }
    // An unstated party end is unknown, so it bounds nothing. Inventing a
    // ceiling here would refuse a sitting the host never said was too late.
    if (party.endsAt && session.endsAt.getTime() > party.endsAt.getTime()) {
      issues.push({ index, field: 'endsAt', message: 'A sitting cannot end after the Party does.' });
    }
    if (session.capacity <= 0) {
      issues.push({ index, field: 'capacity', message: 'A sitting that holds nobody is not a sitting.' });
    }
    if (session.priceCents < 0) {
      issues.push({ index, field: 'priceCents', message: 'A sitting cannot cost less than nothing.' });
    }
    // Mirrors the ticket-tier rule: a price is only sellable on a Party that
    // has a way to take money.
    if (session.priceCents > 0 && party.accessMode !== 'paid-ticket') {
      issues.push({ index, field: 'priceCents', message: 'Only paid Parties can price a sitting.' });
    }
    if (session.name.trim().length === 0) {
      issues.push({ index, field: 'name', message: 'A sitting needs a name the guest can recognise.' });
    }
  });

  // Two sittings called the same thing are indistinguishable on a pass.
  const seen = new Map<string, number>();
  sessions.forEach((session, index) => {
    const key = session.name.trim().toLowerCase();
    if (key.length === 0) return;
    if (seen.has(key)) {
      issues.push({ index, field: 'name', message: 'Two sittings cannot share a name.' });
    } else {
      seen.set(key, index);
    }
  });

  // Sittings may overlap — a host can run two rooms at once — but the seats
  // they sell are the same seats, and the room cannot hold more than the room.
  const seats = sessions.reduce((total, session) => total + Math.max(0, session.capacity), 0);
  if (seats > party.capacity) {
    issues.push({
      index: null,
      field: 'capacity',
      message: `These sittings sell ${seats} seats, which is more than the Party holds (${party.capacity}).`,
    });
  }

  return issues;
}

/**
 * What a guest is allowed to see about a sitting's remaining room.
 *
 * `full` and `passed` are different facts and are never collapsed: one says
 * come back for the next sitting, the other says this one already happened.
 */
export type SessionState = 'open' | 'full' | 'passed';

export function sessionState(
  session: { startsAt: Date; capacity: number; committed: number },
  now: Date = new Date(),
): SessionState {
  if (session.startsAt.getTime() <= now.getTime()) return 'passed';
  return session.committed >= session.capacity ? 'full' : 'open';
}

export function remainingSeats(session: { capacity: number; committed: number }): number {
  return Math.max(0, session.capacity - session.committed);
}
