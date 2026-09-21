import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFeasibility, type CheckName, type PlanConstraints, type Verdict } from './planFeasibility';
import type { PlanLeg } from './planLegs';

const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00Z`);

/** Midtown, and a point ~8.3 miles away. */
const MIDTOWN = { lat: 33.7726, lng: -84.3654 };
const FAR = { lat: 33.6407, lng: -84.4277 };

let seq = 0;
function leg(overrides: Partial<PlanLeg> = {}): PlanLeg {
  seq += 1;
  return {
    itemId: `item-${seq}`,
    position: seq,
    needKind: 'dining',
    title: `Leg ${seq}`,
    startsAt: null,
    durationMins: null,
    latitude: null,
    longitude: null,
    priceCents: null,
    seats: null,
    ...overrides,
  };
}

const plan = (overrides: Partial<PlanConstraints> = {}): PlanConstraints => ({
  startsAt: at('18:00'),
  endsAt: at('23:59'),
  partySize: 4,
  budgetCents: 40_000,
  ...overrides,
});

function verdictFor(check: CheckName, legs: PlanLeg[], constraints: PlanConstraints): Verdict {
  const result = planFeasibility(legs, constraints).checks.find((c) => c.check === check);
  assert.ok(result, `no ${check} check was run`);
  return result.verdict;
}

// ─── Table-driven: each row is one check, one situation, one expected verdict ──

interface Row {
  name: string;
  check: CheckName;
  legs: PlanLeg[];
  constraints?: Partial<PlanConstraints>;
  expect: Verdict;
}

const rows: Row[] = [
  // Window
  { name: 'a leg inside the window fits', check: 'window', expect: 'fits',
    legs: [leg({ startsAt: at('19:00'), durationMins: 90 })] },
  { name: 'a leg starting before the window breaks', check: 'window', expect: 'breaks',
    legs: [leg({ startsAt: at('17:00'), durationMins: 60 })] },
  { name: 'a leg running past the end breaks', check: 'window', expect: 'breaks',
    legs: [leg({ startsAt: at('23:00'), durationMins: 180 })] },
  { name: 'a leg starting inside with no stated length is not judged to run over', check: 'window', expect: 'fits',
    legs: [leg({ startsAt: at('23:30'), durationMins: null })] },
  { name: 'no plan window is unknown, not fits', check: 'window', expect: 'unknown',
    constraints: { startsAt: null, endsAt: null },
    legs: [leg({ startsAt: at('19:00'), durationMins: 60 })] },
  { name: 'an untimed leg alongside a good one keeps the check unknown', check: 'window', expect: 'unknown',
    legs: [leg({ startsAt: at('19:00'), durationMins: 60 }), leg()] },

  // Overlap
  { name: 'two spans back to back fit', check: 'overlap', expect: 'fits',
    legs: [leg({ startsAt: at('19:00'), durationMins: 60 }), leg({ startsAt: at('20:00'), durationMins: 60 })] },
  { name: 'two spans sharing minutes break', check: 'overlap', expect: 'breaks',
    legs: [leg({ startsAt: at('19:00'), durationMins: 90 }), leg({ startsAt: at('20:00'), durationMins: 60 })] },
  { name: 'overlap is caught regardless of the order given', check: 'overlap', expect: 'breaks',
    legs: [leg({ startsAt: at('20:00'), durationMins: 60 }), leg({ startsAt: at('19:00'), durationMins: 90 })] },
  { name: 'a start with no length cannot be shown to clash', check: 'overlap', expect: 'unknown',
    legs: [leg({ startsAt: at('19:00'), durationMins: null }), leg({ startsAt: at('19:30'), durationMins: null })] },
  { name: 'one span alone has nothing to clash with', check: 'overlap', expect: 'unknown',
    legs: [leg({ startsAt: at('19:00'), durationMins: 60 })] },

  // Travel
  { name: 'a long gap over a short hop fits', check: 'travel', expect: 'fits',
    legs: [
      leg({ startsAt: at('19:00'), durationMins: 60, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng }),
      leg({ startsAt: at('21:00'), durationMins: 60, latitude: FAR.lat, longitude: FAR.lng }),
    ] },
  { name: 'eight miles in four minutes breaks even at a generous pace', check: 'travel', expect: 'breaks',
    legs: [
      leg({ startsAt: at('19:00'), durationMins: 60, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng }),
      leg({ startsAt: at('20:04'), durationMins: 60, latitude: FAR.lat, longitude: FAR.lng }),
    ] },
  { name: 'a placeless leg leaves the journey unmeasurable', check: 'travel', expect: 'unknown',
    legs: [
      leg({ startsAt: at('19:00'), durationMins: 60, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng }),
      leg({ startsAt: at('20:00'), durationMins: 60 }),
    ] },

  // Budget
  { name: 'under the ceiling fits', check: 'budget', expect: 'fits',
    legs: [leg({ priceCents: 5_000 }), leg({ priceCents: 2_500 })] },
  { name: 'over the ceiling breaks', check: 'budget', expect: 'breaks',
    legs: [leg({ priceCents: 9_000 }), leg({ priceCents: 2_000 })] },
  { name: 'a free leg is counted as zero, not as unpriced', check: 'budget', expect: 'fits',
    legs: [leg({ priceCents: 0 }), leg({ priceCents: 1_000 })] },
  { name: 'no budget set is unknown', check: 'budget', expect: 'unknown',
    constraints: { budgetCents: null }, legs: [leg({ priceCents: 5_000 })] },
  { name: 'no party size cannot total a per-person price', check: 'budget', expect: 'unknown',
    constraints: { partySize: null }, legs: [leg({ priceCents: 5_000 })] },
  { name: 'an unpriced leg keeps budget unknown even with room to spare', check: 'budget', expect: 'unknown',
    legs: [leg({ priceCents: 1_000 }), leg()] },

  // Capacity
  { name: 'enough seats fits', check: 'capacity', expect: 'fits',
    legs: [leg({ seats: 10 })] },
  { name: 'exactly enough seats fits', check: 'capacity', expect: 'fits',
    legs: [leg({ seats: 4 })] },
  { name: 'too few seats breaks', check: 'capacity', expect: 'breaks',
    legs: [leg({ seats: 2 })] },
  { name: 'a full room breaks rather than reading as uncounted', check: 'capacity', expect: 'breaks',
    legs: [leg({ seats: 0 })] },
  { name: 'supply that does not count seats is unknown', check: 'capacity', expect: 'unknown',
    legs: [leg()] },
  { name: 'no party size means nothing to seat', check: 'capacity', expect: 'unknown',
    constraints: { partySize: null }, legs: [leg({ seats: 10 })] },
];

for (const row of rows) {
  test(`${row.check}: ${row.name}`, () => {
    assert.equal(verdictFor(row.check, row.legs, plan(row.constraints)), row.expect);
  });
}

// ─── Rolling up, and the places a checker is tempted to lie ───────────────────

test('an empty Plan is unknown, never fits', () => {
  // "No problems found" on an empty Plan is an endorsement of nothing.
  const result = planFeasibility([], plan());
  assert.equal(result.verdict, 'unknown');
  assert.ok(result.checks.every((check) => check.verdict === 'unknown'));
  assert.equal(result.checks.length, 5);
});

test('a fully stated, workable Plan fits on every check', () => {
  const result = planFeasibility([
    leg({ title: 'Coffee', startsAt: at('18:00'), durationMins: 45, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng, priceCents: 600, seats: 8 }),
    leg({ title: 'Dinner', startsAt: at('19:30'), durationMins: 90, latitude: FAR.lat, longitude: FAR.lng, priceCents: 4_200, seats: 6 }),
  ], plan());
  assert.equal(result.verdict, 'fits');
  assert.deepEqual(result.checks.filter((c) => c.verdict !== 'fits'), []);
});

test('one break outranks every unknown', () => {
  // A Plan with an impossible leg is broken whatever else is unstated.
  const result = planFeasibility([
    leg({ title: 'Too small', seats: 1 }),
    leg(),
  ], plan());
  assert.equal(result.verdict, 'breaks');
  assert.ok(result.checks.some((check) => check.verdict === 'unknown'));
});

test('a single unknown drags the whole verdict off fits', () => {
  const result = planFeasibility([
    leg({ startsAt: at('19:00'), durationMins: 60, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng, priceCents: 1_000, seats: 8 }),
    leg({ startsAt: at('21:00'), durationMins: 60, latitude: FAR.lat, longitude: FAR.lng, priceCents: null, seats: 8 }),
  ], plan());
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.checks.find((c) => c.check === 'budget')?.verdict, 'unknown');
});

test('every check names the items it is talking about', () => {
  const small = leg({ title: 'Tiny bar', seats: 1 });
  const result = planFeasibility([small], plan());
  const capacity = result.checks.find((check) => check.check === 'capacity')!;
  assert.deepEqual(capacity.itemIds, [small.itemId]);
  assert.match(capacity.detail, /Tiny bar/);
  // Even a passing check explains itself, so the UI never has to invent copy.
  assert.ok(result.checks.every((check) => check.detail.length > 0));
});

test('travel is judged from the end of a leg, not its start', () => {
  // Leaving at the start would buy back the whole sitting and call an
  // impossible hop comfortable.
  const legs = [
    leg({ startsAt: at('19:00'), durationMins: 120, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng }),
    leg({ startsAt: at('21:05'), durationMins: 60, latitude: FAR.lat, longitude: FAR.lng }),
  ];
  assert.equal(verdictFor('travel', legs, plan()), 'breaks');
});

test('the solver is pure: the same Plan twice gives the same answer', () => {
  const legs = [
    leg({ startsAt: at('19:00'), durationMins: 60, latitude: MIDTOWN.lat, longitude: MIDTOWN.lng, priceCents: 1_000, seats: 8 }),
    leg({ startsAt: at('21:00'), durationMins: 60, latitude: FAR.lat, longitude: FAR.lng, priceCents: 2_000, seats: 8 }),
  ];
  assert.deepEqual(planFeasibility(legs, plan()), planFeasibility(legs, plan()));
});

test('the solver does not reorder or mutate the legs it is given', () => {
  const legs = [
    leg({ startsAt: at('21:00'), durationMins: 60 }),
    leg({ startsAt: at('19:00'), durationMins: 60 }),
  ];
  const before = JSON.parse(JSON.stringify(legs));
  planFeasibility(legs, plan());
  assert.deepEqual(JSON.parse(JSON.stringify(legs)), before);
});
