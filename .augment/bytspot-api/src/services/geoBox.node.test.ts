import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundingBoxWhere, longitudeRanges } from './geoBox';
import { distanceMeters } from './checkinProof';

const METERS_PER_MILE = 1609.344;

/** Unrounded, so a point exactly on the boundary is still judged inside.
 *  `distanceMeters` rounds to whole metres, which at small radii pushes a
 *  boundary point just outside and quietly skips the case worth testing. */
function exactMiles(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return (2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)))) / METERS_PER_MILE;
}

/** Does the box the query would use actually admit this point? */
function boxAdmits(box: any, lat: number, lng: number): boolean {
  const latRange = box.AND[0].lat;
  if (lat < latRange.gte || lat > latRange.lte) return false;
  const lngClause = box.AND[1];
  if (!lngClause) return true;
  return lngClause.OR.some((r: any) => lng >= r.lng.gte && lng <= r.lng.lte);
}

/** Degrees are floating point; compare them as such. */
function assertRanges(actual: { gte: number; lte: number }[] | null, expected: [number, number][]) {
  assert.equal(actual?.length, expected.length);
  expected.forEach(([gte, lte], i) => {
    assert.ok(Math.abs(actual![i].gte - gte) < 1e-9, `range ${i} gte ${actual![i].gte} != ${gte}`);
    assert.ok(Math.abs(actual![i].lte - lte) < 1e-9, `range ${i} lte ${actual![i].lte} != ${lte}`);
  });
}

test('An ordinary box is one longitude range and never touches the wrap', () => {
  assertRanges(longitudeRanges(-84.38, 0.2), [[-84.58, -84.18]]);
});

test('A box crossing the antimeridian is split, because a wrapping range cannot be expressed', () => {
  // Just west of the line, reaching east across it.
  assertRanges(longitudeRanges(179.9, 0.2), [[179.7, 180], [-180, -179.9]]);
  // And the mirror, just east reaching west.
  assertRanges(longitudeRanges(-179.9, 0.2), [[179.9, 180], [-180, -179.7]]);
});

test('A circle that reaches every meridian constrains latitude only', () => {
  // Constraining longitude here could only exclude: near the pole every
  // meridian is within the radius.
  assert.equal(longitudeRanges(0, 180), null);
  const atPole = boundingBoxWhere(89.999, 0, 10);
  assert.equal(atPole.AND.length, 1);
  assert.ok('lat' in atPole.AND[0]);
});

test('Longitude widens with latitude, so a northern box is not silently narrow', () => {
  const atlanta = boundingBoxWhere(33.7866, -84.3833, 10) as any;
  const reykjavik = boundingBoxWhere(64.1466, -21.9426, 10) as any;
  const width = (box: any) => {
    const range = box.AND[1].OR[0].lng;
    return range.lte - range.gte;
  };
  assert.ok(width(reykjavik) > width(atlanta), 'a degree of longitude is shorter further north, so the box must be wider');
  // Latitude is the same span at both, because a degree of latitude is not.
  assert.equal(
    Math.round((atlanta.AND[0].lat.lte - atlanta.AND[0].lat.gte) * 1e6),
    Math.round((reykjavik.AND[0].lat.lte - reykjavik.AND[0].lat.gte) * 1e6),
  );
});

test('Latitude is clamped to the poles rather than asking for coordinates that cannot exist', () => {
  const box = boundingBoxWhere(89.9, 0, 50) as any;
  assert.ok(box.AND[0].lat.lte <= 90);
  assert.ok((boundingBoxWhere(-89.9, 0, 50) as any).AND[0].lat.gte >= -90);
});

test('The box never hides a point inside the circle, at any latitude or longitude', () => {
  // The box is only a prefilter if it is permissive. A box narrower than the
  // circle silently drops rows before anything can measure them, and near
  // the poles a small circle still spans every meridian. This walks the
  // circle at many bearings and insists the box admits every point.
  const centres = [
    { lat: 0, lng: 0 }, { lat: 33.7866, lng: -84.3833 }, { lat: 64.1466, lng: -21.9426 },
    { lat: 89.9, lng: 0 }, { lat: 89.99, lng: 45 }, { lat: -89.9, lng: 120 },
    { lat: 33.7866, lng: 179.99 }, { lat: 33.7866, lng: -179.99 }, { lat: 0, lng: 180 },
    { lat: 70, lng: 179.5 }, { lat: -70, lng: -179.5 },
  ];
  for (const centre of centres) {
    for (const radiusMiles of [0.5, 1, 10, 50]) {
      const box = boundingBoxWhere(centre.lat, centre.lng, radiusMiles) as any;
      for (let bearing = 0; bearing < 360; bearing += 3) {
        // Walk out along a great circle to the exact radius.
        const angular = radiusMiles / (6_371_000 / METERS_PER_MILE);
        const lat1 = (centre.lat * Math.PI) / 180;
        const lng1 = (centre.lng * Math.PI) / 180;
        const theta = (bearing * Math.PI) / 180;
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(theta));
        const lng2 = lng1 + Math.atan2(Math.sin(theta) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
        const lat = (lat2 * 180) / Math.PI;
        let lng = ((lng2 * 180) / Math.PI + 540) % 360 - 180;
        if (lat > 90 || lat < -90) continue;
        // Judged with the unrounded distance so boundary points are tested,
        // and cross-checked against the rounded one the endpoint uses.
        const measured = exactMiles(centre, { lat, lng });
        const asEndpointMeasures = distanceMeters({ lat: centre.lat, lng: centre.lng }, { lat, lng }) / METERS_PER_MILE;
        if (measured > radiusMiles && asEndpointMeasures > radiusMiles) continue;
        assert.ok(
          boxAdmits(box, lat, lng),
          `centre ${centre.lat},${centre.lng} r=${radiusMiles} bearing ${bearing}: point ${lat},${lng} is ${measured.toFixed(4)}mi away but the box excluded it`,
        );
      }
    }
  }
});

test('A circle that reaches a pole admits every meridian, even when it is small', () => {
  // The centre is not near enough to the pole for cos(lat) to vanish, but
  // the circle still touches it, so longitude has stopped meaning anything.
  const box = boundingBoxWhere(89.9, 0, 10) as any;
  assert.equal(box.AND.length, 1, 'expected a latitude band with no longitude predicate');
  assert.ok(boxAdmits(box, 89.955, -180));
});

test('Latitude and longitude live under AND, so neither overwrites the other', () => {
  const box = boundingBoxWhere(33.7866, 179.95, 10) as any;
  // The wrapped halves are an OR nested inside AND; a flat object would have
  // lost one of them to a duplicate key.
  assert.equal(box.AND.length, 2);
  assert.equal(box.AND[1].OR.length, 2);
});
