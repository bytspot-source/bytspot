import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import { alertHostOfCircleTicketPurchase, partyAlertRecipient, partyAlertUrl } from './partyAlerts';
import { DEFAULT_PUSH_PREFERENCES, permitsCategory } from './iosPushDevices';
import { isAllowedBytspotUrl } from './notificationDelivery';

const party = db.party as any;
const partyGuest = db.partyGuest as any;
const socialCircleMember = db.socialCircleMember as any;

beforeEach(() => {
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'published' });
  partyGuest.findUnique = async () => ({ userId: 'usr_guest' });
});

test('a host alert reaches the host of that Party and nobody else', async () => {
  assert.equal(await partyAlertRecipient({ kind: 'host', partyId: 'party-1' }), 'usr_host');
});

test('an unpublished or deleted Party addresses no one', async () => {
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'draft' });
  assert.equal(await partyAlertRecipient({ kind: 'host', partyId: 'party-1' }), null);

  party.findUnique = async () => null;
  assert.equal(await partyAlertRecipient({ kind: 'host', partyId: 'party-1' }), null);
});

test('a guest alert reaches only someone on that guest list', async () => {
  assert.equal(await partyAlertRecipient({ kind: 'guest', partyId: 'party-1', userId: 'usr_guest' }), 'usr_guest');

  // Someone who never asked to come has no row, so no Party alert can find them.
  partyGuest.findUnique = async () => null;
  assert.equal(await partyAlertRecipient({ kind: 'guest', partyId: 'party-1', userId: 'usr_stranger' }), null);
});

test('a declined guest is still told they were declined', async () => {
  partyGuest.findUnique = async () => ({ userId: 'usr_guest' });
  assert.equal(await partyAlertRecipient({ kind: 'guest', partyId: 'party-1', userId: 'usr_guest' }), 'usr_guest');
});

test('the party category is on by default and can still be switched off', () => {
  // Party alerts only reach the host or a pass holder, so silence is opt-out.
  assert.equal(DEFAULT_PUSH_PREFERENCES.party, true);
  assert.equal(permitsCategory(null, 'party'), true);
  assert.equal(permitsCategory({ push: { party: false } }, 'party'), false);
  // Turning off one category must not silence the others.
  assert.equal(permitsCategory({ push: { party: false } }, 'reservations'), true);
  assert.equal(permitsCategory({ push: { nearby: true } }, 'party'), true);
});

test('party alerts link to the Party itself on an allowed host', () => {
  const url = partyAlertUrl('party-1');
  assert.equal(isAllowedBytspotUrl(url), true);
  assert.match(url, /\/party\/party-1$/);
  // Ids are encoded rather than interpolated raw into the path.
  assert.match(partyAlertUrl('a/b?c'), /\/party\/a%2Fb%3Fc$/);
});

test('an unpublished Party cannot notify its guests either', async () => {
  // The resolver, not the caller, is what keeps an unpublished Party silent.
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'draft' });
  assert.equal(await partyAlertRecipient({ kind: 'guest', partyId: 'party-1', userId: 'usr_guest' }), null);

  party.findUnique = async () => null;
  assert.equal(await partyAlertRecipient({ kind: 'guest', partyId: 'party-1', userId: 'usr_guest' }), null);
});

test('a circle-member ticket purchase tells the host, and nothing else does', async () => {
  const buyer = { partyId: 'party-1', buyerUserId: 'usr_buyer' };
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'published', audienceCircleIds: ['circle-1'] });
  socialCircleMember.findFirst = async () => ({ id: 'member-1' });
  assert.notEqual(await alertHostOfCircleTicketPurchase(buyer), null);

  // A buyer who is in no circle the host owns is not a social-graph signal.
  socialCircleMember.findFirst = async () => null;
  assert.equal(await alertHostOfCircleTicketPurchase(buyer), null);

  // A public Party addressed to no circle never produces a circle alert.
  socialCircleMember.findFirst = async () => ({ id: 'member-1' });
  party.findUnique = async () => ({ hostUserId: 'usr_host', status: 'published', audienceCircleIds: [] });
  assert.equal(await alertHostOfCircleTicketPurchase(buyer), null);

  // Hosts buying into their own Party do not notify themselves.
  party.findUnique = async () => ({ hostUserId: 'usr_buyer', status: 'published', audienceCircleIds: ['circle-1'] });
  assert.equal(await alertHostOfCircleTicketPurchase(buyer), null);
});
