import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from '../trpc/trpc';
import { appRouter } from '../trpc/router';
import type { Context } from '../trpc/context';
import { db } from '../lib/db';
import { DEFAULT_PUSH_PREFERENCES, permitsCategory } from './iosPushDevices';
import { isAllowedBytspotUrl } from './notificationDelivery';
import { LIVE_CROWD_FRESH_MS } from './latestCrowd';
import {
  VIBE_LOOKBACK_MS,
  VIBE_MAX_SENDS_PER_DAY,
  VIBE_MAX_SENDS_PER_WEEK,
  VIBE_QUIET_END_HOUR,
  VIBE_QUIET_START_HOUR,
  isVibeQuietHours,
  itemHitsAvoid,
  itemMatchesVibe,
  partyVibeTags,
  sendVibeMatches,
  venueVibeTags,
  vibeBusynessLine,
  vibeDedupeKey,
  vibePushCopy,
  type VibeWatermarkStore,
} from './vibeMatches';

const createCaller = createCallerFactory(appRouter);
const authenticated: Context = {
  user: { userId: 'usr_me', email: 'me@bytspot.com' },
  clientRateLimitKey: 'test-vibe-client',
};

/** Saturday 28 Nov 2026, 10:00 AM America/New_York (EST, UTC-5). */
const now = new Date('2026-11-28T15:00:00.000Z');
const minutes = (n: number) => new Date(now.getTime() - n * 60 * 1000);
const hours = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);
const days = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

let venues: any[];
let parties: any[];
let users: any[];
let crowds: any[];
let blocks: any[];
let prior: { userId: string; dedupeKey: string; sentAt: Date }[];
let claims: { userId: string; dedupeKey: string }[];
let deliveries: { userIds: string[]; category: string; title: string; body: string; url: string; type: string }[];
let deliver: (input: any) => Promise<unknown>;

beforeEach(() => {
  venues = [];
  parties = [];
  users = [];
  crowds = [];
  blocks = [];
  prior = [];
  claims = [];
  deliveries = [];
  deliver = async (input) => { deliveries.push(input); };
  (db.venue as any).findMany = async () => venues;
  (db.party as any).findMany = async () => parties;
  (db.user as any).findMany = async () => users;
  (db.user as any).findUnique = async () => ({ notificationPrefs: null });
  (db.user as any).update = async () => ({});
  (db.crowdLevel as any).findMany = async () => crowds;
  (db.userBlock as any).findMany = async () => blocks;
  (db.notificationSend as any).findMany = async () => prior;
  (db.notificationSend as any).create = async ({ data }: any) => {
    if (claims.some((row) => row.userId === data.userId && row.dedupeKey === data.dedupeKey)
      || prior.some((row) => row.userId === data.userId && row.dedupeKey === data.dedupeKey)) {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }
    claims.push(data);
    return data;
  };
});

function member(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    membershipTier: 'green',
    notificationPrefs: { push: { vibe: true } },
    preference: { vibes: ['brunch'], avoid: [] },
    iosPushDevices: [{ id: `device-${id}` }],
    ...overrides,
  };
}

function venue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'venue-1',
    name: 'Daylight',
    slug: 'daylight',
    category: 'brunch',
    lat: 33.781,
    lng: -84.3833,
    createdAt: minutes(30),
    discoverable: true,
    onlineOnly: false,
    address: '12 Secret Lane',
    ...overrides,
  };
}

function party(overrides: Record<string, unknown> = {}) {
  return {
    id: 'party-good',
    title: 'Sunday Table',
    hostUserId: 'host-other',
    templateId: 'pop-up',
    templateConfig: { hostType: 'brunch', hostCategory: 'food-drink' },
    musicGenres: [],
    status: 'published',
    admissionPaused: false,
    closedAt: null,
    cancelledAt: null,
    endsAt: hours(-4),
    startsAt: hours(-2),
    accessMode: 'free-rsvp',
    requiredMembershipTier: 'green',
    audienceCircleIds: [],
    locationDisclosure: 'public',
    shareLinkExpiresAt: null,
    showOnDiscover: false,
    publishedAt: minutes(20),
    lat: 33.781,
    lng: -84.3833,
    moderationHiddenAt: null,
    capacity: 20,
    venueName: '12 Secret Lane',
    host: { suspendedAt: null },
    ...overrides,
  };
}

function run(at = now) {
  return sendVibeMatches(at, { redis: null, since: hours(3), deliver });
}

const prefsInput = {
  push: { reservations: true, promotions: true, reminders: true, insider: true, nearby: false },
  email: { reservations: true, promotions: false, newsletter: true, receipts: true },
  sms: { reservations: true, reminders: true, emergencies: true },
};

test('vibe pushes are off until the member opts in, including rows saved before the category existed', async () => {
  assert.equal(VIBE_MAX_SENDS_PER_DAY, 1);
  assert.equal(VIBE_MAX_SENDS_PER_WEEK, 3);
  assert.equal(VIBE_QUIET_START_HOUR, 22);
  assert.equal(VIBE_QUIET_END_HOUR, 9);
  assert.equal(DEFAULT_PUSH_PREFERENCES.vibe, false);
  assert.equal(permitsCategory(null, 'vibe'), false);
  assert.equal(permitsCategory({}, 'vibe'), false);
  assert.equal(permitsCategory({ push: {} }, 'vibe'), false);
  assert.equal(permitsCategory({ push: { nearby: true } }, 'vibe'), false);
  assert.equal(permitsCategory({ push: { vibe: 'yes' } }, 'vibe'), false);
  assert.equal(permitsCategory({ push: { vibe: false } }, 'vibe'), false);
  assert.equal(permitsCategory({ push: { vibe: true } }, 'vibe'), true);
  // Leaving vibe off does not silence a category that defaults on.
  assert.equal(permitsCategory({ push: { vibe: false } }, 'reservations'), true);

  const user = db.user as any;
  const caller = () => createCaller(authenticated);

  user.findUnique = async () => ({ notificationPrefs: { push: { party: false, nearby: true } } });
  const legacy = await caller().user.notifications.getPrefs();
  assert.equal(legacy.push.vibe, false, 'a stored row with no vibe key reads as off');
  assert.equal(legacy.push.party, false, 'rebuilding the row keeps the choice that was stored');

  user.findUnique = async () => ({ notificationPrefs: null });
  assert.equal((await caller().user.notifications.getPrefs()).push.vibe, false);

  user.findUnique = async () => ({ notificationPrefs: { push: { vibe: 'yes' } } });
  assert.equal((await caller().user.notifications.getPrefs()).push.vibe, false, 'a non-boolean does not count as opt-in');

  user.findUnique = async () => ({ notificationPrefs: { push: { vibe: true } } });
  assert.equal((await caller().user.notifications.getPrefs()).push.vibe, true);

  let saved: any = null;
  user.update = async ({ data }: any) => { saved = data.notificationPrefs; return {}; };

  user.findUnique = async () => ({ notificationPrefs: null });
  await caller().user.notifications.updatePrefs(prefsInput);
  assert.equal(saved.push.vibe, false, 'an older client that omits vibe does not turn it on');

  user.findUnique = async () => ({ notificationPrefs: { push: { vibe: true, party: false } } });
  await caller().user.notifications.updatePrefs(prefsInput);
  assert.equal(saved.push.vibe, true, 'an older client that omits vibe keeps a stored opt-in');
  assert.equal(saved.push.party, false);

  user.findUnique = async () => ({ notificationPrefs: null });
  await caller().user.notifications.updatePrefs({ ...prefsInput, push: { ...prefsInput.push, vibe: true } });
  assert.equal(saved.push.vibe, true);
});

test('a vibe matches a tag or a known profile, and an unknown word matches nothing', () => {
  const brunchParty = { tags: partyVibeTags({ templateConfig: { hostType: 'brunch', hostCategory: 'food-drink' }, musicGenres: ['afrobeats'] }) };
  assert.equal(itemMatchesVibe(brunchParty, 'brunch'), true);
  assert.equal(itemMatchesVibe(brunchParty, 'Brunch'), true);
  assert.equal(itemMatchesVibe(brunchParty, 'dining'), true);
  assert.equal(itemMatchesVibe(brunchParty, 'afrobeats'), true);
  assert.equal(itemMatchesVibe(brunchParty, 'drinks'), false);
  assert.equal(itemMatchesVibe({ tags: partyVibeTags({ templateConfig: {} }) }, 'events'), false, 'an untagged party is not "events"');
  assert.equal(itemMatchesVibe({ tags: partyVibeTags({ templateConfig: { hostType: 'brunch', hostCategory: 'nightlife' } }) }, 'brunch'), false);

  assert.equal(itemMatchesVibe({ tags: venueVibeTags('cafe') }, 'coffee'), true);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('restaurant') }, 'date_night'), true);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('restaurant') }, 'opera'), false);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('park') }, 'coffee'), false);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('nightclub') }, 'drinks'), true);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('nightclub') }, 'nightclub'), true);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('bar') }, 'drinks'), true);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('barrel room') }, 'drinks'), false);
  assert.equal(itemMatchesVibe({ tags: venueVibeTags('clubhouse') }, 'drinks'), false);
  assert.equal(itemHitsAvoid('nightclub', ['nightclubs']), true);
  assert.equal(itemHitsAvoid('cafe', ['nightclubs']), false);
});

test('copy names the vibe and the place, says typically for a curve, and keeps the street off the lock screen', () => {
  const copy = vibePushCopy({
    kind: 'venue', id: 'venue-1', name: 'Daylight', slug: 'daylight',
    lat: 33.781, lng: -84.3833, vibe: 'Brunch', crowdCategory: 'brunch', live: null,
  }, now);
  assert.ok(copy);
  assert.equal(copy.title, 'New for your brunch vibe');
  assert.equal(copy.body, 'Daylight in Midtown. Typically busy before 11 AM.');
  assert.equal(copy.url, 'https://bytspot.app/venue/daylight');
  assert.equal(isAllowedBytspotUrl(copy.url), true);
  assert.match(copy.body, /Typically /);
  assert.doesNotMatch(`${copy.title} ${copy.body}`, /only \d|spots left|hurry|last chance|selling out|limited time|almost full|going fast|secret lane/i);

  const bar = vibeBusynessLine(now, 'bar', null);
  assert.equal(bar, 'Typically chill before 5 PM.');

  const live = vibeBusynessLine(now, 'brunch', {
    level: 1, label: 'Hurry, last table', source: 'user_report', recordedAt: minutes(10),
  });
  assert.equal(live, 'Chill right now.');
  assert.doesNotMatch(live!, /typically|hurry|last table/i);

  const stale = vibeBusynessLine(now, 'bar', {
    level: 4, label: 'Packed', source: 'sensor', recordedAt: new Date(now.getTime() - LIVE_CROWD_FRESH_MS - 1),
  });
  assert.equal(stale, 'Typically chill before 5 PM.');
  const exactly = vibeBusynessLine(now, 'bar', {
    level: 1, label: 'Chill', source: 'bytspot', recordedAt: new Date(now.getTime() - LIVE_CROWD_FRESH_MS),
  });
  assert.equal(exactly, 'Chill right now.');

  const simulated = vibeBusynessLine(now, 'bar', {
    level: 4, label: 'Packed', source: 'typical', recordedAt: minutes(5),
  });
  assert.equal(simulated, 'Typically chill before 5 PM.');

  const unknown = vibePushCopy({
    kind: 'venue', id: 'venue-2', name: 'The Shed', slug: 'the-shed',
    lat: null, lng: null, vibe: 'brunch', crowdCategory: 'warehouse', live: null,
  }, now);
  assert.equal(unknown?.body, 'The Shed.');
  assert.doesNotMatch(unknown!.body, /typically|right now/i);
});

test('quiet hours are 10 PM through 9 AM New York, and the morning boundary sends', () => {
  assert.equal(isVibeQuietHours(new Date('2026-11-28T02:59:00.000Z')), false, '9:59 PM is still a sending hour');
  assert.equal(isVibeQuietHours(new Date('2026-11-28T03:00:00.000Z')), true, '10:00 PM starts quiet hours');
  assert.equal(isVibeQuietHours(new Date('2026-11-28T13:59:00.000Z')), true, '8:59 AM is still quiet');
  assert.equal(isVibeQuietHours(new Date('2026-11-28T14:00:00.000Z')), false, '9:00 AM sends again');
});

test('the job does not query or send during quiet hours, and does not move the cursor', async () => {
  let redisCalls = 0;
  const redis: VibeWatermarkStore = {
    get: async () => { redisCalls += 1; return null; },
    set: async () => { redisCalls += 1; },
  };
  (db.venue as any).findMany = async () => { throw new Error('quiet hours must not query'); };
  venues = [venue()];
  users = [member('member')];
  const result = await sendVibeMatches(new Date('2026-11-28T03:30:00.000Z'), { redis, deliver });
  assert.equal(result.quiet, true);
  assert.equal(result.sent, 0);
  assert.equal(result.since, null);
  assert.equal(redisCalls, 0);
  assert.deepEqual(deliveries, []);
  assert.deepEqual(claims, []);
});

test('a member who has not opted in gets nothing, and one who has gets the new place', async () => {
  venues = [venue()];
  users = [
    member('legacy', { notificationPrefs: null }),
    member('off', { notificationPrefs: { push: { vibe: false, reminders: true } } }),
    member('on'),
  ];
  const result = await run();
  assert.equal(result.sent, 1);
  assert.equal(result.skippedOptOut, 2);
  assert.deepEqual(deliveries.map((row) => row.userIds), [['on']]);
  assert.equal(deliveries[0].category, 'vibe');
  assert.equal(deliveries[0].type, 'vibe.match');
  assert.equal(deliveries[0].title, 'New for your brunch vibe');
  assert.equal(deliveries[0].body, 'Daylight in Midtown. Typically busy before 11 AM.');
  assert.equal(deliveries[0].url, 'https://bytspot.app/venue/daylight');
  assert.doesNotMatch(deliveries[0].body, /secret lane/i);
  assert.deepEqual(claims, [{ userId: 'on', dedupeKey: vibeDedupeKey('venue', 'venue-1') }]);
});

test('a member with the toggle on and no registered device is not sent a vibe push', async () => {
  venues = [venue()];
  users = [member('member', { iosPushDevices: [] })];
  const result = await run();
  assert.equal(result.sent, 0);
  assert.equal(result.skippedNoDevice, 1);
  assert.deepEqual(deliveries, []);
  assert.deepEqual(claims, []);
});

test('no matching tag means no push', async () => {
  venues = [venue({ category: 'brunch' })];
  users = [member('member', { preference: { vibes: ['opera'], avoid: [] } })];
  const result = await run();
  assert.equal(result.sent, 0);
  assert.equal(result.skippedNoMatch, 1);
  assert.equal(result.candidates, 1);
  assert.deepEqual(claims, []);
});

test('an avoided category is not a match, even when the vibe would take it', async () => {
  venues = [venue({ category: 'nightclub' })];
  users = [member('member', { preference: { vibes: ['drinks'], avoid: ['nightclubs'] } })];
  const result = await run();
  assert.equal(result.sent, 0);
  assert.equal(result.skippedNoMatch, 1);
});

test('one push per day and three per week, and a repeated item is not a second push', async () => {
  venues = [venue(), venue({ id: 'venue-older', name: 'Earlier', slug: 'earlier', createdAt: minutes(50) })];
  users = [member('member')];

  const first = await run();
  assert.equal(first.sent, 1);
  assert.equal(claims[0].dedupeKey, vibeDedupeKey('venue', 'venue-1'), 'the newer place is the one we send');
  assert.equal(deliveries.length, 1);

  claims = [];
  deliveries = [];
  prior = [{ userId: 'member', dedupeKey: vibeDedupeKey('venue', 'venue-1'), sentAt: new Date('2026-11-28T14:00:00.000Z') }];
  const sameDay = await run();
  assert.equal(sameDay.sent, 0);
  assert.equal(sameDay.skippedCaps, 1, 'the older place is still new, and the daily cap holds it');
  assert.deepEqual(claims, []);

  prior = [
    { userId: 'member', dedupeKey: 'vibe.match:venue:a', sentAt: new Date('2026-11-22T15:00:00.000Z') },
    { userId: 'member', dedupeKey: 'vibe.match:venue:b', sentAt: new Date('2026-11-24T15:00:00.000Z') },
    { userId: 'member', dedupeKey: 'vibe.match:venue:c', sentAt: new Date('2026-11-26T15:00:00.000Z') },
  ];
  const week = await run();
  assert.equal(week.sent, 0);
  assert.equal(week.skippedCaps, 1);

  prior = [
    { userId: 'member', dedupeKey: 'vibe.match:venue:a', sentAt: new Date('2026-11-22T15:00:00.000Z') },
    { userId: 'member', dedupeKey: 'vibe.match:venue:b', sentAt: new Date('2026-11-26T15:00:00.000Z') },
  ];
  claims = [];
  deliveries = [];
  const under = await run();
  assert.equal(under.sent, 1);
  assert.equal(under.skippedCaps, 0);

  prior = [{ userId: 'member', dedupeKey: vibeDedupeKey('venue', 'venue-1'), sentAt: new Date('2026-11-27T15:00:00.000Z') }];
  claims = [];
  deliveries = [];
  venues = [venue()];
  const repeated = await run();
  assert.equal(repeated.sent, 0);
  assert.equal(repeated.skippedDuplicate, 1);
  assert.equal(repeated.skippedCaps, 0, 'yesterday does not use up today');
  assert.equal(claims.length, 0);

  venues = [venue(), venue({ id: 'venue-older', name: 'Earlier', slug: 'earlier', createdAt: minutes(50) })];
  const next = await run();
  assert.equal(next.sent, 1);
  assert.equal(claims[0].dedupeKey, vibeDedupeKey('venue', 'venue-older'));
  assert.match(deliveries[0].body, /^Earlier in Midtown\./);
});

test('a fresh live reading is said as right now, and a stale or typical row stays on the curve', async () => {
  venues = [venue()];
  users = [member('member')];
  crowds = [{ venueId: 'venue-1', level: 1, label: 'Chill', source: 'user_report', recordedAt: minutes(10) }];
  await run();
  assert.equal(deliveries[0].body, 'Daylight in Midtown. Chill right now.');
  assert.doesNotMatch(deliveries[0].body, /typically/i);

  deliveries = [];
  claims = [];
  crowds = [{ venueId: 'venue-1', level: 4, label: 'Packed', source: 'typical', recordedAt: minutes(5) }];
  await run();
  assert.match(deliveries[0].body, /Typically /);
  assert.doesNotMatch(deliveries[0].body, /right now/i);
});

test('only a public Host Studio party published in the window is a candidate, and the lock screen gets no address', async () => {
  const good = party();
  parties = [
    good,
    party({ id: 'own', hostUserId: 'member', publishedAt: minutes(5), title: 'My Own Room' }),
    party({ id: 'black', requiredMembershipTier: 'black', publishedAt: minutes(4), title: 'Black Door' }),
    party({ id: 'suspended', hostUserId: 'suspended-host', host: { suspendedAt: now }, publishedAt: minutes(3), title: 'Suspended Room' }),
    party({ id: 'blocked', hostUserId: 'blocked-host', publishedAt: minutes(2), title: 'Blocked Room' }),
    party({ id: 'private', templateId: 'private-party', publishedAt: minutes(15), title: 'Private Room' }),
    party({ id: 'withheld', locationDisclosure: 'after-approval', publishedAt: minutes(15), title: 'Hidden Address' }),
    party({ id: 'circle', audienceCircleIds: ['circle-1'], publishedAt: minutes(15), title: 'Circle Room' }),
    party({ id: 'draft', status: 'draft', publishedAt: minutes(15), title: 'Draft Room' }),
    party({ id: 'cancelled', cancelledAt: now, publishedAt: minutes(15), title: 'Cancelled Room' }),
    party({ id: 'hidden', moderationHiddenAt: now, publishedAt: minutes(15), title: 'Hidden Room' }),
    party({ id: 'old', publishedAt: days(10), title: 'Old Room' }),
    party({ id: 'expired', shareLinkExpiresAt: minutes(1), publishedAt: minutes(15), title: 'Expired Room' }),
    party({ id: 'ended', endsAt: minutes(30), startsAt: hours(5), publishedAt: minutes(15), title: 'Ended Room' }),
    party({ id: 'approval', accessMode: 'private-approval', showOnDiscover: true, publishedAt: minutes(15), title: 'Approval Room' }),
  ];
  blocks = [{ blockerId: 'member', blockedId: 'blocked-host' }];
  users = [member('member')];
  const result = await run();
  assert.equal(result.sent, 1);
  assert.equal(claims[0].dedupeKey, vibeDedupeKey('party', 'party-good'));
  assert.equal(deliveries[0].url, 'https://bytspot.app/party/party-good');
  assert.equal(isAllowedBytspotUrl(deliveries[0].url), true);
  assert.match(deliveries[0].body, /^Sunday Table in Midtown\./);
  assert.doesNotMatch(`${deliveries[0].title} ${deliveries[0].body}`, /secret lane|private room|hidden address|circle room|my own room/i);
});

test('a hidden or online-only venue is not announced, and a first run stays inside seven days', async () => {
  venues = [
    venue({ id: 'online', slug: 'online', name: 'Online Only', onlineOnly: true, createdAt: minutes(5) }),
    venue({ id: 'hidden', slug: 'hidden', name: 'Hidden', discoverable: false, createdAt: minutes(5) }),
    venue(),
  ];
  users = [member('member')];
  const result = await run();
  assert.equal(result.sent, 1);
  assert.equal(deliveries[0].url, 'https://bytspot.app/venue/daylight');

  venues = [venue({ createdAt: new Date(now.getTime() - VIBE_LOOKBACK_MS - 60 * 60 * 1000) })];
  claims = [];
  deliveries = [];
  const tooOld = await sendVibeMatches(now, { redis: null, deliver });
  assert.equal(tooOld.sent, 0);
  assert.equal(tooOld.candidates, 0);

  venues = [venue({ createdAt: new Date(now.getTime() - VIBE_LOOKBACK_MS + 60 * 60 * 1000) })];
  const inside = await sendVibeMatches(now, { redis: null, deliver });
  assert.equal(inside.sent, 1);
});

test('the cursor is the previous run, never more than seven days, and a future cursor does not skip backward', async () => {
  let stored = hours(2).toISOString();
  const sets: string[] = [];
  const redis: VibeWatermarkStore = {
    get: async () => stored,
    set: async (_key, value) => { sets.push(value); stored = value; },
  };
  venues = [
    venue({ id: 'before', slug: 'before', name: 'Before', createdAt: hours(3) }),
    venue({ id: 'after', slug: 'after', name: 'After', createdAt: minutes(30) }),
  ];
  users = [member('member')];
  const result = await sendVibeMatches(now, { redis, deliver });
  assert.equal(result.sent, 1);
  assert.equal(claims[0].dedupeKey, vibeDedupeKey('venue', 'after'));
  assert.deepEqual(sets, [now.toISOString()]);

  stored = days(-1).toISOString();
  sets.length = 0;
  claims = [];
  deliveries = [];
  venues = [venue()];
  const future = await sendVibeMatches(now, { redis, deliver });
  assert.equal(future.sent, 0);
  assert.equal(future.candidates, 0);
  assert.deepEqual(sets, [now.toISOString()]);

  // A cursor older than the lookback is raised to seven days, so an eight-day-old
  // place stays outside the window.
  stored = days(30).toISOString();
  sets.length = 0;
  claims = [];
  deliveries = [];
  venues = [venue({ createdAt: new Date(now.getTime() - VIBE_LOOKBACK_MS - 60 * 60 * 1000) })];
  const capped = await sendVibeMatches(now, { redis, deliver });
  assert.equal(capped.candidates, 0);
  assert.equal(capped.sent, 0);
});
