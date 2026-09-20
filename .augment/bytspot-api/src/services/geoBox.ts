// Bounding box for a radius search, as a Prisma `where` fragment.
//
// The box is a prefilter, never the answer: it keeps the scan small and the
// caller still measures true distance on what comes back. That division of
// labour only holds if the box is permissive — a box that is too small
// silently hides real results before anything can measure them.
//
// Two places where the naive box is too small:
//   * near the poles a degree of longitude shrinks toward zero, so a radius
//     of any size eventually spans every meridian;
//   * at the antimeridian the longitude range wraps, and `gte`/`lte` cannot
//     express a range that wraps, so it must be split into two.

const MILES_PER_DEGREE_LATITUDE = 69;

type Range = { gte: number; lte: number };

/** Prisma cannot express a wrapping range, so a box crossing ±180 becomes two. */
export function longitudeRanges(lng: number, deltaDegrees: number): Range[] | null {
  // The circle reaches every meridian: constraining longitude at all would
  // only exclude. This is the pole case, and the honest box is a latitude band.
  if (deltaDegrees >= 180) return null;
  const min = lng - deltaDegrees;
  const max = lng + deltaDegrees;
  if (min < -180) return [{ gte: min + 360, lte: 180 }, { gte: -180, lte: max }];
  if (max > 180) return [{ gte: min, lte: 180 }, { gte: -180, lte: max - 360 }];
  return [{ gte: min, lte: max }];
}

/**
 * A `where` fragment matching rows whose `lat`/`lng` fall in the box around a
 * point. Shaped for any model carrying `lat` and `lng` — a Party's own
 * coordinates or a Venue's.
 */
export function boundingBoxWhere(lat: number, lng: number, radiusMiles: number) {
  const latDelta = radiusMiles / MILES_PER_DEGREE_LATITUDE;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // cos goes to zero at the poles; dividing by it there is an infinite span,
  // which `longitudeRanges` reads as "every meridian" rather than a clamp.
  const lngDelta = cosLat <= 1e-9 ? 360 : radiusMiles / (MILES_PER_DEGREE_LATITUDE * cosLat);
  const latRange: Range = {
    gte: Math.max(-90, lat - latDelta),
    lte: Math.min(90, lat + latDelta),
  };
  const ranges = longitudeRanges(lng, lngDelta);
  // Latitude and longitude are ANDed; the wrapped longitude halves are ORed.
  // Both live under AND so neither can overwrite the other's key.
  return { AND: ranges === null ? [{ lat: latRange }] : [{ lat: latRange }, { OR: ranges.map((lngRange) => ({ lng: lngRange })) }] };
}
