import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import {
  deliverPushNotification,
  readPushDeliveryTotals,
  resetPushDeliveryTotalsForTests,
} from './notificationDelivery';

const iosPushDevice = db.iOSPushDevice as any;

const alert = {
  userIds: ['usr_1'],
  // party defaults on, so the device is eligible without a preferences row.
  category: 'party' as const,
  title: 'Bytspot',
  body: 'Your spot just opened up',
  url: 'https://bytspot.app/discover',
  type: 'party-rsvp',
};

beforeEach(() => {
  resetPushDeliveryTotalsForTests();
  iosPushDevice.findMany = async () => ([
    { token: 'a'.repeat(64), environment: 'production', user: { notificationPrefs: null } },
  ]);
});

test('A send that reaches nobody is counted, not swallowed', async () => {
  // Unconfigured APNs skips before it opens a connection, which is the exact
  // shape of the silent failure: a real device, a real send, and no delivery.
  const result = await deliverPushNotification(alert);
  assert.equal(result.devices, 1);
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);

  const totals = await readPushDeliveryTotals();
  assert.equal(totals.skipped, 1);
  assert.equal(totals.sent, 0);
  // The field that answers "has a push ever been delivered".
  assert.equal(totals.lastSentAt, null);
});

test('Addressing no one records nothing at all', async () => {
  assert.deepEqual(await deliverPushNotification({ ...alert, userIds: [] }), {
    targetedUsers: 0, devices: 0, sent: 0, skipped: 0, permanentFailures: 0, temporaryFailures: 0,
  });

  // A non-Bytspot URL is refused before any device is looked up.
  const offsite = await deliverPushNotification({ ...alert, url: 'https://evil.example/discover' });
  assert.equal(offsite.devices, 0);

  const totals = await readPushDeliveryTotals();
  assert.deepEqual(totals, { sent: 0, skipped: 0, permanentFailures: 0, temporaryFailures: 0, lastSentAt: null });
});

test('Totals accumulate across sends so the tally is a history, not a snapshot', async () => {
  await deliverPushNotification(alert);
  await deliverPushNotification({ ...alert, userIds: ['usr_1', 'usr_2'] });
  const totals = await readPushDeliveryTotals();
  assert.equal(totals.skipped, 2);
});
