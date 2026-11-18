import assert from 'node:assert/strict';
import test from 'node:test';
import { activeDayOf, createActivityRecorder } from './activity';
import { bucketBounds, rangeShape, retentionFor, weekStarts } from './growth';
import { isLinkPreviewAgent, noteShareView } from './shareViews';

test('a member is written at most once a day, and a failed write waits for the next day', async () => {
  const writes: string[] = [];
  let fail = false;
  const note = createActivityRecorder(async (userId, day) => { writes.push(`${userId}:${day}`); if (fail) throw new Error('db down'); });
  const morning = new Date('2026-11-16T09:00:00Z');
  note('u1', morning); note('u1', new Date('2026-11-16T22:00:00Z')); note(null, morning); note('u2', morning);
  assert.deepEqual(writes, ['u1:2026-11-16', 'u2:2026-11-16']);
  note('u1', new Date('2026-11-17T01:00:00Z'));
  assert.equal(writes.at(-1), 'u1:2026-11-17');
  fail = true;
  note('u3', morning);
  await new Promise((resolve) => setImmediate(resolve));
  fail = false;
  note('u3', morning);
  assert.equal(writes.filter((w) => w.startsWith('u3')).length, 1, 'a failed write is not retried on every request');
  note('u3', new Date('2026-11-17T09:00:00Z'));
  assert.equal(writes.at(-1), 'u3:2026-11-17');
});

test('weeks start on Monday UTC, oldest first, ending with this week', () => {
  const weeks = weekStarts(new Date('2026-11-18T15:00:00Z'), 3).map(activeDayOf);
  assert.deepEqual(weeks, ['2026-11-02', '2026-11-09', '2026-11-16']);
  assert.equal(activeDayOf(weekStarts(new Date('2026-11-16T00:00:00Z'), 1)[0]), '2026-11-16', 'a Monday is its own week');
  assert.equal(activeDayOf(weekStarts(new Date('2026-11-22T23:59:00Z'), 1)[0]), '2026-11-16', 'Sunday belongs to the week before');
});

test('ranges up to 3 months go by week, longer ones by calendar month, ending with the current one', () => {
  const now = new Date('2026-11-18T15:00:00Z');
  assert.deepEqual(rangeShape('8w'), { bucket: 'week', count: 8 });
  const quarter = bucketBounds(now, '3m');
  assert.equal(quarter.bucket, 'week');
  assert.equal(quarter.starts.length, 13);
  assert.equal(activeDayOf(quarter.starts.at(-1)!), '2026-11-16');
  const year = bucketBounds(now, '12m');
  assert.equal(year.bucket, 'month');
  assert.deepEqual(year.starts.map(activeDayOf).slice(0, 2), ['2025-12-01', '2026-01-01']);
  assert.equal(activeDayOf(year.starts.at(-1)!), '2026-11-01');
  assert.equal(activeDayOf(year.ends.at(-1)!), '2026-12-01');
  assert.equal(activeDayOf(year.ends[1]), '2026-02-01', 'February ends on March 1');
  assert.deepEqual(bucketBounds(new Date('2026-03-31T12:00:00Z'), '6m').starts.map(activeDayOf),
    ['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01'], 'month arithmetic crosses the year');
});

test('coming-back figures count only members whose window has passed', () => {
  const week = new Date('2026-10-05T00:00:00Z');
  const signup = new Date('2026-10-05T12:00:00Z');
  const members = [
    { createdAt: signup, activeDays: ['2026-10-05', '2026-10-06', '2026-10-20'] },
    { createdAt: signup, activeDays: ['2026-10-05', '2026-10-09'] },
    { createdAt: signup, activeDays: ['2026-10-05'] },
    { createdAt: signup, activeDays: ['2026-10-05', '2026-11-03'] },
  ];
  const done = retentionFor(week, members, new Date('2026-11-16T00:00:00Z'));
  assert.deepEqual(done, { weekStart: '2026-10-05', signedUp: 4, day1: 25, week1: 50, month1: 50 }, 'days 8-30 are 10-13 to 11-04: 10-20 and 11-03 count');

  const early = retentionFor(week, members, new Date('2026-10-08T00:00:00Z'));
  assert.equal(early.day1, 25);
  assert.equal(early.week1, null, 'a week has not passed yet');
  assert.equal(early.month1, null);
  assert.equal(retentionFor(week, members, new Date('2026-10-06T10:00:00Z')).day1, null, 'the day after signing up is not over');
});

test('link previews are not counted as people opening a share link', async () => {
  for (const agent of [undefined, '', 'facebookexternalhit/1.1 Facebot Twitterbot/1.0', 'WhatsApp/2.23', 'Slackbot-LinkExpanding 1.0',
    'TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'Mozilla/5.0 (compatible; Googlebot/2.1)']) {
    assert.equal(isLinkPreviewAgent(agent), true, String(agent));
  }
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  assert.equal(isLinkPreviewAgent(iphone), false);
  const saved: string[] = [];
  noteShareView('plan', 'p1', iphone, async (kind, id) => { saved.push(`${kind}:${id}`); });
  noteShareView('plan', 'p1', 'WhatsApp/2.23', async (kind, id) => { saved.push(`${kind}:${id}`); });
  noteShareView('party', 'x', iphone, async () => { throw new Error('db down'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, ['plan:p1']);
});
