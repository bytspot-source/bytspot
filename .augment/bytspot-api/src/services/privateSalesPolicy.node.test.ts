import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferredSaleCategory, looksLikeEventTicket, saleListingProblem } from './privateSalesPolicy';

test('an explicit event-ticket listing always needs a face value', () => {
  assert.equal(looksLikeEventTicket({ title: 'Blue jacket', category: 'event-ticket' }), true);
  assert.match(saleListingProblem({ title: 'Blue jacket', category: 'event-ticket', priceCents: 2000 }, { newSeller: false })!, /face value/);
});

test('a ticket-like title cannot skip the face-value cap by using other or omitting category', () => {
  for (const title of ['2 GA Coldplay', 'Hawks vs Celtics, 2 seats', 'VIP pass for Saturday', 'festival entry pass', 'Coldplay tickets']) {
    assert.equal(looksLikeEventTicket({ title, category: 'other' }), true, title);
    assert.equal(inferredSaleCategory(title), 'event-ticket', title);
    assert.match(saleListingProblem({ title, category: 'other', priceCents: 9000 }, { newSeller: false })!, /face value/, title);
    assert.match(saleListingProblem({ title, priceCents: 9000 }, { newSeller: false })!, /face value/, title);
    assert.match(saleListingProblem({ title, category: 'other', priceCents: 9000, faceValueCents: 8000 }, { newSeller: false })!, /face value or less/, title);
    assert.equal(saleListingProblem({ title, category: 'other', priceCents: 8000, faceValueCents: 8000 }, { newSeller: false }), null, title);
  }
});

test('ordinary goods are not treated as tickets', () => {
  for (const title of ['Jordan 4 Retro, size 10', 'Yoga mat', 'Office chair', 'Wine glasses set of 6', 'Backpack']) {
    assert.equal(looksLikeEventTicket({ title, category: 'other' }), false, title);
    assert.equal(inferredSaleCategory(title), 'other', title);
    assert.equal(saleListingProblem({ title, category: 'other', priceCents: 2000 }, { newSeller: false }), null, title);
  }
  assert.equal(inferredSaleCategory('Office chair', 'electronics'), 'electronics');
});
