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
//
// The longitude span is spherical, not a flat miles-per-degree estimate. A
// flat estimate is narrower than the true circle, and anything narrower hides
// rows. The earth radius is the one `distanceMeters` measures with, so the
// box and the measurement cannot disagree about what is inside.

const EARTH_RADIUS_MILES = 6_371_000 / 1609.344;
const DEGREES_PER_RADIAN = 180 / Math.PI;
/** Floating point must never be the reason a row on the boundary is dropped. */
const BOUNDARY_PAD_DEGREES = 1e-6;

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
  const angularRadius = radiusMiles / EARTH_RADIUS_MILES;
  const latDelta = angularRadius * DEGREES_PER_RADIAN + BOUNDARY_PAD_DEGREES;
  const latRange: Range = {
    gte: Math.max(-90, lat - latDelta),
    lte: Math.min(90, lat + latDelta),
  };
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // A circle that touches a pole contains every meridian, however small it
  // is: longitude stops meaning anything there. That is true before cos(lat)
  // reaches zero, so the pole is detected by the circle reaching it — not by
  // the centre being close to it.
  const reachesPole = latRange.lte >= 90 || latRange.gte <= -90 || cosLat <= Math.sin(angularRadius);
  const lngDelta = reachesPole
    ? 360
    : Math.asin(Math.sin(angularRadius) / cosLat) * DEGREES_PER_RADIAN + BOUNDARY_PAD_DEGREES;
  const ranges = longitudeRanges(lng, lngDelta);
  // Latitude and longitude are ANDed; the wrapped longitude halves are ORed.
  // Both live under AND so neither can overwrite the other's key.
  return { AND: ranges === null ? [{ lat: latRange }] : [{ lat: latRange }, { OR: ranges.map((lngRange) => ({ lng: lngRange })) }] };
}
