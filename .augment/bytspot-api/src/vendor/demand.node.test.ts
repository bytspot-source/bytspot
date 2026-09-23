import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveSlots, type DerivableWindow } from './availability';
import {
  DEMAND_DEFAULTS,
  anyMatch,
  canRunDemandOperation,
  categoryForDomain,
  demandCategoryIds,
  domainsForCategory,
  evaluateDemand,
  stateAfterOperation,
  type EvaluableDemand,
  type EvaluableSupply,
} from './demand';

/**
 * The rules the console already runs, asserted server side. Every case here is
 * a miss a vendor is entitled to see the reason for: a demand filtered away
 * silently is the one thing this feed must not do.
 */

const NOW = new Date('2026-06-30T00:00:00Z');

function supply(overrides: Partial<EvaluableSupply> = {}): EvaluableSupply {
  const window: DerivableWindow = {
    id: 'window-1',
    domain: 'dining',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    openMins: 18 * 60,
    closeMins: 21 * 60,
    quantity: 6,
    slotKind: 'rolling',
    slotMinutes: 60,
    leadTimeMins: 60,
    horizonDays: 30,
  };
  return {
    windowId: 'window-1',
    domain: 'dining',
    latitude: 33.7866,
    longitude: -84.3833,
    serviceRadiusMiles: null,
    priceCents: 5000,
    maxGuests: 6,
    slots: deriveSlots({ window, timeZone: 'America/New_York', from: new Date('2026-07-01T00:00:00Z'), now: NOW }),
    ...overrides,
  };
}

function demand(overrides: Partial<EvaluableDemand> = {}): EvaluableDemand {
  return {
    id: 'demand-1',
    category: 'dining',
    state: 'OPEN',
    partySize: 2,
    earliest: new Date('2026-07-01T22:00:00Z'),
    latest: new Date('2026-07-02T01:00:00Z'),
    latitude: 33.7866,
    longitude: -84.3833,
    radiusMiles: 10,
    budgetCents: null,
    ...overrides,
  };
}

function reasons(evaluation: { misses: { rule: string }[] }): string[] {
  return evaluation.misses.map((item) => item.rule);
}

test('a demand a seller can actually answer matches', () => {
  const evaluation = evaluateDemand(demand(), supply(), NOW);
  assert.deepEqual(reasons(evaluation), []);
  assert.equal(evaluation.matched, true);
  assert.ok(evaluation.slots.length > 0);
});

test('a category is matched through its domains, never by name', () => {
  // coffee and dining are different categories with different domains, and the
  // rule compares the category's domains against what the seller actually sells.
  assert.ok(domainsForCategory('dining').includes('dining'));
  assert.ok(!domainsForCategory('coffee').includes('dining'));

  assert.deepEqual(reasons(evaluateDemand(demand({ category: 'coffee' }), supply(), NOW)), ['category']);
});

test('a Discover rail is not a category, and matches nothing', () => {
  // eat_drink is a consumer rail. It carries no domains, so it can never be
  // evaluated, which is exactly why the column stores a category instead.
  assert.deepEqual(domainsForCategory('eat_drink'), []);
  assert.ok(!demandCategoryIds().includes('eat_drink'));
  assert.deepEqual(reasons(evaluateDemand(demand({ category: 'eat_drink' }), supply(), NOW)), ['category']);
});

test('every failure is collected, so the vendor learns more than the first problem', () => {
  const evaluation = evaluateDemand(
    demand({ category: 'coffee', partySize: 40, budgetCents: 100, latitude: 40.7, longitude: -74 }),
    supply(),
    NOW,
  );
  assert.deepEqual(reasons(evaluation), ['category', 'location', 'party', 'budget', 'capacity']);
  assert.equal(evaluation.matched, false);
});

test('reach is the wider of the two, because either side may be the one travelling', () => {
  const far = demand({ latitude: 33.9, longitude: -84.6, radiusMiles: 1 });
  assert.ok(reasons(evaluateDemand(far, supply(), NOW)).includes('location'));

  // The same request answered by a vendor who travels far enough to reach it.
  const travelling = supply({ serviceRadiusMiles: 40 });
  assert.ok(!reasons(evaluateDemand(far, travelling, NOW)).includes('location'));
});

test('a party is not split across two tables to manufacture a match', () => {
  // Six seats free, seven asked for. Two slots of six is not a table for seven.
  assert.ok(reasons(evaluateDemand(demand({ partySize: 7 }), supply(), NOW)).includes('party'));
});

test('budget is only applied when the guest named one', () => {
  assert.ok(!reasons(evaluateDemand(demand({ budgetCents: null }), supply({ priceCents: 999_99 }), NOW)).includes('budget'));
  assert.ok(reasons(evaluateDemand(demand({ budgetCents: 1000 }), supply({ priceCents: 5000 }), NOW)).includes('budget'));
  // Priced exactly at the budget is within it.
  assert.ok(!reasons(evaluateDemand(demand({ budgetCents: 5000 }), supply({ priceCents: 5000 }), NOW)).includes('budget'));
});

test('the window is widened by the contracts flexibility, not by a guess', () => {
  const slots = supply().slots;
  const first = slots[0].startsAt;
  // A request ending just before the first slot still matches, because the
  // guest said they were flexible and the contract says by how much.
  const justBefore = new Date(first.getTime() - (DEMAND_DEFAULTS.flexibilityMins - 5) * 60_000);
  const flexible = demand({ earliest: new Date(justBefore.getTime() - 60_000), latest: justBefore });
  assert.ok(!reasons(evaluateDemand(flexible, supply(), NOW)).includes('capacity'));

  // Well outside it, and there is honestly nothing to offer.
  const longBefore = new Date(first.getTime() - (DEMAND_DEFAULTS.flexibilityMins + 120) * 60_000);
  const rigid = demand({ earliest: new Date(longBefore.getTime() - 60_000), latest: longBefore });
  assert.ok(reasons(evaluateDemand(rigid, supply(), NOW)).includes('capacity'));
});

test('capacity is the only rule that reads availability, and it is read last', () => {
  const empty = supply({ slots: [] });
  const evaluation = evaluateDemand(demand(), empty, NOW);
  assert.deepEqual(reasons(evaluation), ['capacity']);
  // Ordered, so the first miss is the one closest to fixable.
  const many = evaluateDemand(demand({ partySize: 99 }), empty, NOW);
  assert.deepEqual(reasons(many), ['party', 'capacity']);
});

test('a seller matches when any one window does', () => {
  const wrong = supply({ windowId: 'w-coffee', domain: 'coffee' });
  assert.equal(anyMatch(demand(), [wrong], NOW), false);
  assert.equal(anyMatch(demand(), [wrong, supply()], NOW), true);
});

test('an operation is legal only where the contract says, and only with SELL', () => {
  // OFFER is reachable from MATCHED and nowhere else: offering against a
  // request nobody has matched would promise capacity never checked.
  assert.equal(canRunDemandOperation('OFFER', 'MATCHED', ['SELL']), true);
  assert.equal(canRunDemandOperation('OFFER', 'OPEN', ['SELL']), false);
  assert.equal(canRunDemandOperation('OFFER', 'BOOKED', ['SELL']), false);

  // A seat that cannot sell cannot answer, whatever the state.
  assert.equal(canRunDemandOperation('OFFER', 'MATCHED', ['VIEW']), false);

  assert.equal(canRunDemandOperation('DECLINE', 'MATCHED', ['SELL']), true);
  assert.equal(canRunDemandOperation('DECLINE', 'OFFERED', ['SELL']), true);
  assert.equal(canRunDemandOperation('WITHDRAW_OFFER', 'OFFERED', ['SELL']), true);
  assert.equal(canRunDemandOperation('WITHDRAW_OFFER', 'MATCHED', ['SELL']), false);

  assert.equal(canRunDemandOperation('INVENT', 'MATCHED', ['SELL']), false);
});

test('a declined request returns to open rather than disappearing', () => {
  // Every matching seller sees a demand, so one seller passing cannot end it.
  assert.equal(stateAfterOperation('DECLINE'), 'OPEN');
  assert.equal(stateAfterOperation('WITHDRAW_OFFER'), 'OPEN');
  assert.equal(stateAfterOperation('OFFER'), 'OFFERED');
});

test('an ask about a window is raised under a category that matches its own domain', () => {
  // Every domain a window can have must be askable, or its card would show an
  // Ask that the API refuses.
  for (const domain of ['dining', 'nightlife', 'wellness', 'automotive', 'stay', 'stall', 'green', 'coffee', 'shopping', 'events', 'fitness']) {
    const category = categoryForDomain(domain);
    assert.ok(category, `${domain} has no category`);
    assert.ok(domainsForCategory(category!).includes(domain));
  }
  assert.equal(categoryForDomain('spaceport'), undefined);
});

test('an ask notice goes to the seller contact, else its live owners and managers', async () => {
  const { askNoticeRecipients } = await import('./askNotice');
  const seats = [
    { role: 'owner', state: 'ACTIVE', email: 'o@x.com' },
    { role: 'manager', state: 'ACTIVE', email: 'm@x.com' },
    { role: 'manager', state: 'REVOKED', email: 'gone@x.com' },
    { role: 'staff', state: 'ACTIVE', email: 's@x.com' },
    { role: 'owner', state: 'ACTIVE', email: 'o@x.com' },
  ];
  assert.deepEqual(askNoticeRecipients(' front@x.com ', seats), ['front@x.com']);
  assert.deepEqual(askNoticeRecipients(null, seats), ['o@x.com', 'm@x.com']);
  assert.deepEqual(askNoticeRecipients('', []), []);
});

test('an ask notice names the time in the place\'s own clock', async () => {
  const { formatAskWhen } = await import('./askNotice');
  const at = new Date('2026-09-24T23:00:00.000Z');
  assert.equal(formatAskWhen(at, 'America/New_York'), 'Thu, Sep 24, 7:00 PM');
  assert.match(formatAskWhen(at, null), /11:00 PM UTC$/);
});
