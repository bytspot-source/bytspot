/**
 * Reservable tables inside a Party.
 *
 * A ticket tier is the gate fee — what it costs to be in the room at all. A
 * table is reserved space inside that room, and its price is charged on top of
 * the gate rather than instead of it. The two never compete to be the price on
 * one pass: a guest can hold a gate ticket, a table, or both, and the pass has
 * to be able to say which.
 *
 * Validation is a pure function over the host's draft and the Party it belongs
 * to, so the host is told which table is wrong instead of meeting a database
 * constraint violation. The database still holds the same rules — these are the
 * readable half of a pair, never the only guard.
 */

export interface TableDraft {
  name: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  priceCents: number;
  requiredMembershipTier?: string | null;
}

export interface TableHostParty {
  startsAt: Date;
  /// Null when the host never stated an end, in which case a table has a
  /// floor but no ceiling — an unstated end is unknown, not midnight.
  endsAt: Date | null;
  capacity: number;
}

export interface TableIssue {
  index: number | null;
  field: string;
  message: string;
}

/**
 * Every complaint at once, indexed to the table that caused it, so a host
 * fixing a four-table evening is not told about one problem per attempt.
 * `index` is null for a complaint about the set rather than a member.
 */
export function validateTables(tables: TableDraft[], party: TableHostParty): TableIssue[] {
  const issues: TableIssue[] = [];
  if (tables.length === 0) return issues;

  tables.forEach((table, index) => {
    if (table.endsAt.getTime() <= table.startsAt.getTime()) {
      issues.push({ index, field: 'endsAt', message: 'A table must end after it starts.' });
    }
    if (table.startsAt.getTime() < party.startsAt.getTime()) {
      issues.push({ index, field: 'startsAt', message: 'A table cannot start before the Party does.' });
    }
    // An unstated party end is unknown, so it bounds nothing. Inventing a
    // ceiling here would refuse a table the host never said was too late.
    if (party.endsAt && table.endsAt.getTime() > party.endsAt.getTime()) {
      issues.push({ index, field: 'endsAt', message: 'A table cannot end after the Party does.' });
    }
    if (table.capacity <= 0) {
      issues.push({ index, field: 'capacity', message: 'A table that holds nobody is not a table.' });
    }
    if (table.priceCents < 0) {
      issues.push({ index, field: 'priceCents', message: 'A table cannot cost less than nothing.' });
    }
    if (table.name.trim().length === 0) {
      issues.push({ index, field: 'name', message: 'A table needs a name the guest can recognise.' });
    }
  });

  // Two tables called the same thing are indistinguishable on a pass.
  const seen = new Map<string, number>();
  tables.forEach((table, index) => {
    const key = table.name.trim().toLowerCase();
    if (key.length === 0) return;
    if (seen.has(key)) {
      issues.push({ index, field: 'name', message: 'Two tables cannot share a name.' });
    } else {
      seen.set(key, index);
    }
  });

  // Tables may overlap — a host can run two rooms at once — but the seats
  // they sell are the same seats, and the room cannot hold more than the room.
  const seats = tables.reduce((total, table) => total + Math.max(0, table.capacity), 0);
  if (seats > party.capacity) {
    issues.push({
      index: null,
      field: 'capacity',
      message: `These tables sell ${seats} seats, which is more than the Party holds (${party.capacity}).`,
    });
  }

  return issues;
}

/**
 * What a guest is allowed to see about a table's remaining room.
 *
 * `full` and `passed` are different facts and are never collapsed: one says
 * come back for the next table, the other says this one already happened.
 */
export type TableState = 'open' | 'full' | 'passed';

export function tableState(
  table: { startsAt: Date; capacity: number; committed: number },
  now: Date = new Date(),
): TableState {
  if (table.startsAt.getTime() <= now.getTime()) return 'passed';
  return table.committed >= table.capacity ? 'full' : 'open';
}

export function remainingSeats(table: { capacity: number; committed: number }): number {
  return Math.max(0, table.capacity - table.committed);
}
