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
  position: number;
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
  position: number;
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
    lat?: number | null;
    lng?: number | null;
  } | null;
  coffeeReservation?: {
    coffeeSpot?: { latitude: number | null; longitude: number | null } | null;
  } | null;
  coffeeSpot?: { latitude: number | null; longitude: number | null } | null;
  bookable?: { priceCents: number | null; capacity: number | null } | null;
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
  const { offer, party, bookable } = source;

  const startsAt = offer?.startsAt ?? party?.startsAt ?? null;

  // A duration is only ever measured, never assumed. A party states one by
  // having both ends; an offer states one outright; coffee states none.
  const durationMins = offer?.durationMins
    ?? minutesBetween(party?.startsAt ?? null, party?.endsAt ?? null);

  const place = coordinate(offer?.lat, offer?.lng)
    ?? coordinate(party?.lat, party?.lng)
    ?? coordinate(source.coffeeReservation?.coffeeSpot?.latitude, source.coffeeReservation?.coffeeSpot?.longitude)
    ?? coordinate(source.coffeeSpot?.latitude, source.coffeeSpot?.longitude);

  // The offer's agreed price outranks the snapshot. `?? null` rather than `|| 0`
  // throughout: a free item costs 0 and a priceless one costs nothing knowable,
  // and a budget check has to tell those apart.
  const priceCents = offer?.priceCents ?? bookable?.priceCents ?? null;

  const seats = party?.capacity ?? bookable?.capacity ?? null;

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

/** Every item as a leg, in the order the Plan states. Ties break on position
 *  then id so the sequence is total even where positions collide. */
export function legsForPlan(sources: readonly PlanLegSource[]): PlanLeg[] {
  return [...sources]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map(legForItem);
}
