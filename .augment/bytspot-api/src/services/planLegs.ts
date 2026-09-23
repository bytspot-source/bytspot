/**
 * One Plan item, reduced to the facts a feasibility question needs.
 *
 * A Plan item points at one of four kinds of supply, and each kind knows a
 * different amount about itself. A party knows when it starts, where it is and
 * how many it seats. A won vendor offer knows its start, its length and its
 * price. A coffee reservation knows only that a hold expires. An unreserved
 * coffee spot knows only where it is.
 *
 * Every field here is therefore nullable, and null means *not supplied* — it
 * never means zero, and it never means "assume the usual". A leg with no start
 * time is not a leg at nine o'clock; it is a leg whose time nobody has stated,
 * and the solver has to say so rather than quietly place it. The entire point
 * of this module is to keep that distinction intact on the way in, because once
 * a missing time has been defaulted to something plausible the lie is
 * indistinguishable from a fact downstream.
 */
export interface PlanLeg {
  itemId: string;
  /** Null for a row written before this column existed, or by an instance
   *  still running the previous deploy. Such an item has no stated place in
   *  the sequence and is lived last, in the order it was attached. */
  position: number | null;
  needKind: string;
  title: string;
  /** Null when no supply under this item states a start. */
  startsAt: Date | null;
  /** Null when nothing states how long it runs. A start alone cannot imply an end. */
  durationMins: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Per-person, in cents. Null is unknown; 0 is genuinely free and is not null. */
  priceCents: number | null;
  /** Seats the supply can still take, null when the supply does not count seats. */
  seats: number | null;
}

/** The supply a Plan item can point at. Every field optional: callers select
 *  what they have, and a kind that is absent simply contributes nothing. */
export interface PlanLegSource {
  id: string;
  position: number | null;
  /** The tie-break between items sharing a position, and the whole ordering
   *  for items that have none. Matches how `plans.get` reads them back. */
  createdAt: Date;
  needKind: string;
  title: string;
  party?: {
    startsAt: Date | null;
    endsAt: Date | null;
    lat: number | null;
    lng: number | null;
    capacity: number | null;
  } | null;
  offer?: {
    startsAt: Date;
    durationMins: number;
    priceCents: number;
    capacity: number;
    lat?: number | null;
    lng?: number | null;
  } | null;
  coffeeReservation?: {
    coffeeSpot?: { latitude: number | null; longitude: number | null } | null;
  } | null;
  coffeeSpot?: { latitude: number | null; longitude: number | null } | null;
}

/**
 * The position an item appended to this Plan should take.
 *
 * One item past the highest stated position, so an attach adds to the end of
 * the sequence rather than displacing anything already in it. Reusing an
 * existing item leaves the count alone, so a retry cannot walk the order
 * forward.
 *
 * Items with no stated position are skipped rather than counted as zero, so
 * this is only the whole answer for a Plan where every item has one. Callers
 * that are about to write must use `sequenceForAppend`, which repairs the
 * unpositioned rows first — left alone they sort last forever, and the
 * appended item would overtake them permanently rather than for one deploy.
 */
export function nextPosition(items: readonly { position: number | null }[]): number {
  return items.reduce((highest, item) =>
    item.position === null ? highest : Math.max(highest, item.position + 1), 0);
}

export interface SequencedItem {
  id: string;
  position: number | null;
  createdAt: Date;
}

/**
 * Where an appended item goes, and what has to be fixed first.
 *
 * A row with no stated position can only have been written by an instance
 * running a deploy that predates the column. Readers put it last, which is
 * right in isolation, but it is not self-correcting: the next append takes a
 * finite position, finite sorts before null, and the older item is overtaken
 * for good. So a write is the moment to settle it. Each unpositioned row is
 * given a real position after the highest stated one, in the order it was
 * attached, which is exactly where readers had been placing it — the repair
 * is therefore invisible, and it happens once.
 *
 * `repairs` must be applied in the same transaction as the insert, or a
 * failed write leaves the Plan half-renumbered.
 */
export function sequenceForAppend(items: readonly SequencedItem[]): {
  repairs: { id: string; position: number }[];
  position: number;
} {
  let next = nextPosition(items);
  const repairs = items
    .filter((item) => item.position === null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((item) => ({ id: item.id, position: next++ }));
  return { repairs, position: next };
}

/** Whole minutes between two instants, or null when either end is unstated or
 *  the pair is not ordered. A negative duration is not a short leg — it is a
 *  contradiction, and reporting it as unknown keeps it out of arithmetic. */
export function minutesBetween(from: Date | null | undefined, to: Date | null | undefined): number | null {
  if (!from || !to) return null;
  const mins = Math.round((to.getTime() - from.getTime()) / 60_000);
  return Number.isFinite(mins) && mins > 0 ? mins : null;
}

/** A coordinate pair only counts when BOTH halves are present and on Earth.
 *  Half a coordinate is not a location, and 0/0 is the Atlantic — it is the
 *  shape an unset pair takes when someone defaults it, so it is refused. */
function coordinate(lat: number | null | undefined, lng: number | null | undefined): { lat: number; lng: number } | null {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/**
 * Reduce one item to a leg.
 *
 * Where two kinds of supply both state a fact, the one that committed wins: a
 * won offer has an agreed time and an agreed price, so it outranks the party
 * projection sitting behind it. Nothing is invented to fill a gap.
 */
export function legForItem(source: PlanLegSource): PlanLeg {
  const { offer, party } = source;

  const startsAt = offer?.startsAt ?? party?.startsAt ?? null;

  // A duration is only ever measured, never assumed. A party states one by
  // having both ends; an offer states one outright; coffee states none.
  const durationMins = offer?.durationMins
    ?? minutesBetween(party?.startsAt ?? null, party?.endsAt ?? null);

  const place = coordinate(offer?.lat, offer?.lng)
    ?? coordinate(party?.lat, party?.lng)
    ?? coordinate(source.coffeeReservation?.coffeeSpot?.latitude, source.coffeeReservation?.coffeeSpot?.longitude)
    ?? coordinate(source.coffeeSpot?.latitude, source.coffeeSpot?.longitude);

  // Only an accepted offer states a price. The `Bookable` snapshot is not
  // consulted: `partyToBookableSnapshot` and `coffeeToBookableSnapshot` write
  // `priceCents: 0` as a placeholder because a Plan item attaches to a room
  // rather than a ticket tier, and tier pricing is read live at booking time.
  // Reading that placeholder here would report a paid party as free — the
  // exact collapse of unknown into fact this module exists to prevent.
  // `?? null` rather than `|| 0`: a free item costs 0 and a priceless one
  // costs nothing knowable, and a budget check has to tell those apart.
  const priceCents = offer?.priceCents ?? null;

  // Same reasoning for seats. A party counts them, an offer states them, and
  // the coffee snapshot's `capacity: 0`/`1` is a placeholder for supply that
  // does not count seats at all.
  const seats = party?.capacity ?? offer?.capacity ?? null;

  return {
    itemId: source.id,
    position: source.position,
    needKind: source.needKind,
    title: source.title,
    startsAt,
    durationMins,
    latitude: place?.lat ?? null,
    longitude: place?.lng ?? null,
    priceCents,
    seats,
  };
}

/**
 * Every item as a leg, in the order the Plan states.
 *
 * The tie-break is position, then createdAt, then id — the same three keys,
 * in the same order, that `plans.get` reads items back with. Feasibility
 * judging a different sequence from the one the guest is looking at would be
 * a subtle and very hard to see lie.
 *
 * An item with no position sorts after every item that has one. A row written
 * by an instance still on the previous deploy has not stated where it belongs,
 * and appending it is the only reading that does not reorder someone's
 * evening behind their back.
 */
export function legsForPlan(sources: readonly PlanLegSource[]): PlanLeg[] {
  return [...sources]
    .sort((a, b) =>
      (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
      || a.createdAt.getTime() - b.createdAt.getTime()
      || a.id.localeCompare(b.id))
    .map(legForItem);
}
