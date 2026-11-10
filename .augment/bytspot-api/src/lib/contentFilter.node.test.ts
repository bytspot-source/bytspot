import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { checkText, filteredText, keywordContentFilter, normalizeForFilter, setContentFilter } from './contentFilter';

test('ordinary party, plan and sale text passes', () => {
  for (const text of [
    'Friday rooftop listening party', 'Jordan 4 Retro, size 10', 'Dinner then drinks in Midtown',
    'Play Kendrick next please!', 'Scunthorpe United watch party', 'Spicy wings and a pool table', 'Night shift crew hangout',
  ]) assert.equal(checkText(text, { blockContactInfo: true }).ok, true, text);
});

test('slurs are refused through common obfuscation', () => {
  assert.deepEqual(checkText('you f4ggot').categories, ['slur']);
  assert.deepEqual(checkText('n.i.g.g.a').categories, ['slur']);
});

test('sexual content involving minors and threats are refused', () => {
  assert.ok(checkText('underage nudes').categories.includes('sexual-minors'));
  assert.ok(checkText('im gonna shoot up the party').categories.includes('threat') || checkText('shoot up the party').categories.includes('threat'));
});

test('contact details are refused only where the context asks', () => {
  assert.equal(checkText('text me 404-555-0123').ok, true);
  assert.deepEqual(checkText('text me 404-555-0123', { blockContactInfo: true }).categories, ['contact-info']);
  assert.ok(checkText('venmo me @kojo', { blockContactInfo: true }).categories.includes('contact-info'));
  assert.ok(checkText('dm kojo@example.com', { blockContactInfo: true }).categories.includes('contact-info'));
});

test('normalisation de-leets and joins split letters', () => {
  assert.equal(normalizeForFilter('H3LL0'), 'hello');
  assert.equal(normalizeForFilter('a.b.c'), 'abc');
});

test('the filter is swappable and the zod helper uses whichever is active', () => {
  const schema = filteredText(z.string());
  assert.equal(schema.safeParse('anything').success, true);
  const previous = setContentFilter({ check: () => ({ ok: false, categories: ['threat'] }) });
  try {
    assert.equal(schema.safeParse('anything').success, false);
  } finally {
    setContentFilter(previous);
  }
  assert.equal(previous, keywordContentFilter);
});
