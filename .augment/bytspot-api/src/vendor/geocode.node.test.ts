import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  candidateBlockers,
  mapCandidates,
  precisionSufficientFor,
  requiredPrecisionFor,
  type GeocodeCandidate,
} from './geocode';

const result = (locationType: string, types: string[] = [], lat = 33.78, lng = -84.38) => ({
  formatted_address: '1 Peachtree St NE, Atlanta, GA 30303',
  types,
  geometry: { location: { lat, lng }, location_type: locationType },
});

test('a rooftop match is rooftop, an interpolated one is only street', () => {
  assert.equal(mapCandidates([result('ROOFTOP')])[0].precision, 'rooftop');
  // Estimated between two known house numbers. Street-accurate, not rooftop.
  assert.equal(mapCandidates([result('RANGE_INTERPOLATED')])[0].precision, 'street');
});

test('a geometric centre is read down, not up', () => {
  // The midpoint of a road is street-accurate.
  assert.equal(mapCandidates([result('GEOMETRIC_CENTER', ['route'])])[0].precision, 'street');
  // The midpoint of anything larger is not, and over-stating precision is the
  // failure this field exists to prevent.
  assert.equal(mapCandidates([result('GEOMETRIC_CENTER', ['park'])])[0].precision, 'locality');
});

test('an approximate match is a locality at best', () => {
  assert.equal(mapCandidates([result('APPROXIMATE', ['locality'])])[0].precision, 'locality');
  assert.equal(mapCandidates([result('APPROXIMATE', ['postal_code'])])[0].precision, 'locality');
  assert.equal(mapCandidates([result('APPROXIMATE', ['country'])])[0].precision, 'region');
});

test('Null Island is dropped, not returned as a pin', () => {
  // Every provider emits it eventually, and it is always a failed lookup that
  // forgot to say so.
  assert.deepEqual(mapCandidates([result('ROOFTOP', [], 0, 0)]), []);
});

test('an impossible coordinate is dropped', () => {
  assert.deepEqual(mapCandidates([result('ROOFTOP', [], 91, 0)]), []);
  assert.deepEqual(mapCandidates([result('ROOFTOP', [], 0, 181)]), []);
  assert.deepEqual(mapCandidates([{ formatted_address: 'x', geometry: {} }]), []);
});

test('candidates come back most precise first', () => {
  const ordered = mapCandidates([
    result('APPROXIMATE', ['locality']),
    result('ROOFTOP'),
    result('RANGE_INTERPOLATED'),
  ]);
  assert.deepEqual(
    ordered.map((candidate) => candidate.precision),
    ['rooftop', 'street', 'locality'],
  );
});

test('a place guests travel to needs a street, one the vendor travels from does not', () => {
  assert.equal(requiredPrecisionFor('fixed'), 'street');
  assert.equal(requiredPrecisionFor('zone'), 'street');
  // The pin is the centre of a radius, so a centroid is a legitimate answer —
  // a visiting provider should not have to publish their street.
  assert.equal(requiredPrecisionFor('mobile'), 'locality');
  assert.equal(requiredPrecisionFor('visiting'), 'locality');
});

test('a town centroid is refused for a place guests navigate to', () => {
  const centroid: GeocodeCandidate = {
    formatted: 'Atlanta, GA',
    lat: 33.749,
    lng: -84.388,
    precision: 'locality',
  };
  assert.ok(!precisionSufficientFor('fixed', 'locality'));
  const blockers = candidateBlockers('fixed', centroid);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /street address, not just a town/);

  // The same candidate is fine for a vendor who travels.
  assert.deepEqual(candidateBlockers('visiting', centroid), []);
});

test('a region is too broad even for a travel radius', () => {
  const region: GeocodeCandidate = { formatted: 'Georgia', lat: 32.6, lng: -83.4, precision: 'region' };
  assert.match(candidateBlockers('visiting', region)[0], /too broad/);
});

test('an unknown kind is refused rather than defaulted', () => {
  const candidate: GeocodeCandidate = { formatted: 'x', lat: 1, lng: 1, precision: 'rooftop' };
  assert.deepEqual(candidateBlockers('warehouse' as never, candidate), ['warehouse is not a location kind']);
});

test('a rooftop pin at Null Island is still refused', () => {
  // Precision high, coordinate meaningless: both are checked, because a
  // provider will happily claim the first about the second.
  const broken: GeocodeCandidate = { formatted: '', lat: 0, lng: 0, precision: 'rooftop' };
  assert.deepEqual(candidateBlockers('fixed', broken), ['That result came back empty']);
});
