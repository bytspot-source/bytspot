import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../config';
import { db } from '../lib/db';
import { hostPayoutDelayHours, isNewHost, newHostTierProblem } from './hostTrust';

const party = db.party as any;
const limits = { maxCents: 20_000, maxQuantity: 200 };

test('new-host tiers above the price or quantity cap are refused with a reason', () => {
  assert.equal(newHostTierProblem([{ name: 'GA', priceCents: 2500, quantity: 100 }], limits), null);
  assert.match(newHostTierProblem([{ name: 'VIP', priceCents: 50_000, quantity: 10 }], limits)!, /\$200/);
  assert.match(newHostTierProblem([{ name: 'GA', priceCents: 2500, quantity: 5000 }], limits)!, /200 paid tickets/);
  assert.equal(newHostTierProblem([{ name: 'Free', priceCents: 0, quantity: 10_000 }], limits), null, 'free tiers are not capped');
  assert.equal(newHostTierProblem(null, limits), null);
});

test('a host is new until enough paid parties have settled', async () => {
  party.count = async () => 2;
  assert.equal(await isNewHost('h1'), config.newHostTrustedAfterParties > 2);
  party.count = async () => 3;
  assert.equal(await isNewHost('h1'), false);
});

test('new hosts get the longer payout delay', async () => {
  party.count = async () => 0;
  assert.equal(await hostPayoutDelayHours('h1'), Math.max(config.partyPayoutDelayHours, config.newHostPayoutDelayHours));
  party.count = async () => 50;
  assert.equal(await hostPayoutDelayHours('h1'), config.partyPayoutDelayHours);
});

test('defaults are conservative: payouts off, $200 / 200 caps, 7-day new-host delay', () => {
  assert.equal(config.partyPayoutsEnabled, process.env.PARTY_PAYOUTS_ENABLED === 'true');
  if (!process.env.NEW_HOST_MAX_TICKET_CENTS) assert.equal(config.newHostMaxTicketCents, 20_000);
  if (!process.env.NEW_HOST_MAX_TICKET_QUANTITY) assert.equal(config.newHostMaxTicketQuantity, 200);
  if (!process.env.NEW_HOST_PAYOUT_DELAY_HOURS) assert.equal(config.newHostPayoutDelayHours, 168);
});
