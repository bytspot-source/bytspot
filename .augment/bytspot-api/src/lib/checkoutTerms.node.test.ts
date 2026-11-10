import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PARTY_CHECKOUT_TERMS, VENDOR_TICKET_CHECKOUT_TERMS } from './checkoutTerms';

test('REA X3: checkout refund terms fit Stripe custom_text and are wired into both checkouts', () => {
  for (const text of [PARTY_CHECKOUT_TERMS, VENDOR_TICKET_CHECKOUT_TERMS]) {
    assert.ok(text.length <= 1200, 'Stripe caps custom_text at 1200 characters');
    assert.match(text, /full refund/);
  }
  const src = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');
  assert.match(src('trpc/partyRouter.ts'), /custom_text: \{ submit: \{ message: PARTY_CHECKOUT_TERMS \} \}/);
  assert.match(src('vendor/tickets.ts'), /custom_text: \{ submit: \{ message: VENDOR_TICKET_CHECKOUT_TERMS \} \}/);
});

test('REA V3: door pass lookups are rate-limited per seat', () => {
  const route = readFileSync(join(__dirname, '..', 'routes/vendorBookings.ts'), 'utf8');
  assert.match(route, /'\/vendor\/passes\/verify', requireVendorSeat, requireCapability\('VERIFY'\), passLookupLimiter/);
});

test('REA bottle terms: checkout copy and session line items never charge alcohol', () => {
  assert.match(PARTY_CHECKOUT_TERMS, /does not charge for them/);
  const party = readFileSync(join(__dirname, '..', 'trpc/partyRouter.ts'), 'utf8');
  assert.match(party, /sessionStripeDescription\(partySession\)/);
  assert.doesNotMatch(party, /bottles included/);
  const sessions = readFileSync(join(__dirname, '..', 'services/partySessions.ts'), 'utf8');
  assert.match(sessions, /includedBottlesProblem/);
});
