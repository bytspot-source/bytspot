import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundingBoxWhere, longitudeRanges } from './geoBox';

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

test('Latitude and longitude live under AND, so neither overwrites the other', () => {
  const box = boundingBoxWhere(33.7866, 179.95, 10) as any;
  // The wrapped halves are an OR nested inside AND; a flat object would have
  // lost one of them to a duplicate key.
  assert.equal(box.AND.length, 2);
  assert.equal(box.AND[1].OR.length, 2);
});
