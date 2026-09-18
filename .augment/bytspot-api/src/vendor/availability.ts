import bookableTemplates from './contracts/bookable-templates.json';

/**
 * Slots, derived rather than stored.
 *
 * The console derives the same grid in `src/vendor/availability.ts`, and the
 * two must agree, because the vendor reads one and the guest is sold the other.
 * The difference is where "local" comes from. In the console it is the browser,
 * which is the vendor standing in their own shop. Here it is the location's
 * timezone, because the API runs in UTC and a 7pm window would otherwise
 * print 7pm UTC — afternoon slots for an Atlanta seller, and a different set
 * of days either side of a DST boundary.
 *
 * A window that names no timezone is not guessed at. It yields no slots, so a
 * misconfigured location sells nothing rather than selling the wrong hour.
 */

const availability = bookableTemplates.availability;

export type SlotState = 'OPEN' | 'HELD' | 'FULL' | 'BLOCKED' | 'CLOSED' | 'PASSED';

export interface AvailabilityDefaults {
  slotKind: string;
  slotMinutes: number;
  leadTimeMins: number;
  horizonDays: number;
}

/** Domain defaults layered over the contract's, exactly as the console layers them. */
export function availabilityDefaultsFor(domain: string): AvailabilityDefaults {
  const base = availability.defaults;
  const override = availability.domainDefaults.find((entry) => entry.domain === domain);
  return {
    slotKind: override?.slotKind ?? base.slotKind,
    slotMinutes: override?.slotMinutes ?? base.slotMinutes,
    leadTimeMins: override?.leadTimeMins ?? base.leadTimeMins,
    horizonDays: override?.horizonDays ?? base.horizonDays,
  };
}

/** The window a seller declared, as stored. */
export interface DerivableWindow {
  id: string;
  domain: string;
  weekdays: number[];
  openMins: number;
  closeMins: number;
  quantity: number;
  slotKind: string;
  slotMinutes: number;
  leadTimeMins: number;
  horizonDays: number;
}

/** A fact already taken against one derived instant. */
export interface Commitment {
  startsAt: Date;
  committed: number;
  blocked: boolean;
  closed: boolean;
}

export interface DerivedSlot {
  id: string;
  startsAt: Date;
  startMins: number;
  weekday: number;
  quantity: number;
  committed: number;
  blocked: boolean;
  closed: boolean;
  state: SlotState;
  remaining: number;
  minimumQuantity: number;
}

/** Minutes the zone is ahead of UTC at a given instant. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // Hour 24 is how this formatter spells midnight; Date.UTC would read it as
  // the next day and the offset would come out a day wrong.
  const hour = read('hour') % 24;
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), hour, read('minute'), read('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which a local wall-clock time occurs in a zone.
 *
 * Resolved twice because the offset depends on the instant we are still
 * solving for: on a DST boundary the first guess uses the wrong side of the
 * shift, and a window would open an hour early for one day of the year.
 */
function zonedInstant(year: number, month: number, day: number, minutes: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  const first = zoneOffsetMinutes(new Date(naive), timeZone);
  const candidate = naive - first * 60_000;
  const second = zoneOffsetMinutes(new Date(candidate), timeZone);
  return new Date(second === first ? candidate : naive - second * 60_000);
}

/** The local calendar date in a zone, as numbers. */
function zonedDateParts(instant: Date, timeZone: string): { year: number; month: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    weekday: weekdays.indexOf(read('weekday')),
  };
}

function startMinutesFor(window: DerivableWindow, kind: string): number[] {
  // A fixed or daily window is one named start time, so its open is the slot.
  if (kind === 'daily' || kind === 'fixed') return [window.openMins];
  const starts: number[] = [];
  for (let mins = window.openMins; mins + window.slotMinutes <= window.closeMins; mins += window.slotMinutes) {
    starts.push(mins);
  }
  return starts;
}

function slotState(slot: { quantity: number; committed: number; blocked: boolean; closed: boolean; startsAt: Date }, now: Date): SlotState {
  // Order matters and is the contract's: a slot that has already happened is
  // PASSED whatever else was true of it, and a blocked slot is not merely full.
  if (slot.startsAt.getTime() <= now.getTime()) return 'PASSED';
  if (slot.blocked) return 'BLOCKED';
  if (slot.closed) return 'CLOSED';
  if (slot.committed >= slot.quantity) return 'FULL';
  if (slot.committed > 0) return 'HELD';
  return 'OPEN';
}

/**
 * A window times its slot length times its quantity, minus what has been taken.
 *
 * Commitments are matched by instant, so a row that no longer lines up with any
 * derived start — the window moved after the fact was recorded — is ignored
 * rather than applied to a neighbouring slot.
 */
export function deriveSlots(options: {
  window: DerivableWindow;
  timeZone: string | null;
  commitments?: Commitment[];
  from?: Date;
  now?: Date;
}): DerivedSlot[] {
  const { window, timeZone } = options;
  if (!timeZone) return [];

  const from = options.from ?? new Date();
  const now = options.now ?? from;
  const defaults = availabilityDefaultsFor(window.domain);
  const horizon = Math.min(window.horizonDays, defaults.horizonDays);

  const taken = new Map<number, Commitment>();
  for (const commitment of options.commitments ?? []) taken.set(commitment.startsAt.getTime(), commitment);

  const slots: DerivedSlot[] = [];
  for (let dayOffset = 0; dayOffset < horizon; dayOffset += 1) {
    const cursor = new Date(from.getTime() + dayOffset * 86_400_000);
    const local = zonedDateParts(cursor, timeZone);
    if (!window.weekdays.includes(local.weekday)) continue;

    for (const startMins of startMinutesFor(window, window.slotKind)) {
      const startsAt = zonedInstant(local.year, local.month, local.day, startMins, timeZone);
      const commitment = taken.get(startsAt.getTime());
      // Capped rather than trusted: a commitment above the window's quantity
      // means the seller shrank the window after taking bookings, and the slot
      // is full, not negative.
      const committed = Math.min(commitment?.committed ?? 0, window.quantity);
      const shape = {
        quantity: window.quantity,
        committed,
        blocked: commitment?.blocked ?? false,
        closed: commitment?.closed ?? false,
        startsAt,
      };
      slots.push({
        id: `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}T${startMins}`,
        startsAt,
        startMins,
        weekday: local.weekday,
        quantity: shape.quantity,
        committed,
        blocked: shape.blocked,
        closed: shape.closed,
        state: slotState(shape, now),
        remaining: Math.max(0, shape.quantity - committed),
        minimumQuantity: 1,
      });
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * The lead time is the seller's promise to themselves: a slot inside it is
 * still open on the calendar but too close to sell.
 */
export function isWithinLeadTime(slot: DerivedSlot, domain: string, now: Date = new Date()): boolean {
  return slot.startsAt.getTime() - now.getTime() < availabilityDefaultsFor(domain).leadTimeMins * 60_000;
}

export function sellableSlots(slots: DerivedSlot[], domain: string, now?: Date): DerivedSlot[] {
  return slots.filter((slot) => slot.state === 'OPEN' && !isWithinLeadTime(slot, domain, now));
}
