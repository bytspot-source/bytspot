import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { db } from '../lib/db';
import {
  apnsPayload,
  deliverPushNotification,
  readPushDeliveryTotals,
  resetPushDeliveryTotalsForTests,
} from './notificationDelivery';
import { pushPresentation, pushThreadId } from './pushPresentation';

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

test('Only what is about to happen to the member is Time Sensitive; other people\'s activity waits in the summary', () => {
  assert.equal(pushPresentation('reminder.party', '30m').interruptionLevel, 'time-sensitive');
  assert.equal(pushPresentation('reminder.plan', '30m').interruptionLevel, 'time-sensitive');
  assert.equal(pushPresentation('reminder.plan', '2h').interruptionLevel, 'active');
  assert.equal(pushPresentation('reminder.party', '24h').interruptionLevel, 'passive');
  assert.equal(pushPresentation('plan-stop-busy').interruptionLevel, 'time-sensitive');
  for (const type of ['party.rsvp', 'plan.joined', 'plan.changed', 'feedback.request']) {
    assert.equal(pushPresentation(type).interruptionLevel, 'passive', type);
  }
  assert.equal(pushPresentation('demand-offer').interruptionLevel, 'active');
  assert.equal(pushPresentation('reminder.party', '2h').category, 'PARTY_REMINDER');
  assert.equal(pushPresentation('reminder.plan', '2h').category, undefined);
});

test('Pushes stack by the Party, Plan or venue they open', () => {
  assert.equal(pushThreadId('https://bytspot.app/party/p_1?intent=arrival'), 'party:p_1');
  assert.equal(pushThreadId('https://bytspot.app/plan/pl_2'), 'plan:pl_2');
  assert.equal(pushThreadId('https://bytspot.app/venue/the-optimist'), 'venue:the-optimist');
  assert.equal(pushThreadId('https://bytspot.app/discover'), undefined);
  assert.equal(pushThreadId('https://bytspot.app/feedback?kind=plan&id=pl_2'), undefined);
});

test('The payload carries presentation and only Bytspot action routes', () => {
  const payload = apnsPayload({
    title: 'Time to head out',
    body: 'Rooftop starts in 30 minutes.',
    url: 'https://bytspot.app/party/p_1?intent=arrival',
    type: 'reminder.party',
    stage: '30m',
    actions: { directions: 'https://bytspot.app/party/p_1?intent=arrival', pass: 'https://evil.example/party/p_1' },
  });
  assert.deepEqual(payload.aps, {
    alert: { title: 'Time to head out', body: 'Rooftop starts in 30 minutes.' },
    sound: 'default',
    'interruption-level': 'time-sensitive',
    'relevance-score': 1,
    'thread-id': 'party:p_1',
    category: 'PARTY_REMINDER',
  });
  assert.deepEqual(payload.actions, { directions: 'https://bytspot.app/party/p_1?intent=arrival' });
  assert.equal('actions' in apnsPayload({ title: 't', body: 'b', url: 'https://bytspot.app/discover', type: 'packed' }), false);
});
