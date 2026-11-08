import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { db } from '../lib/db';
import { currentCrowd, LIVE_CROWD_FRESH_MS, pruneTypicalCrowd, recentCrowd, TYPICAL_RETENTION_MS, withLatestCrowd } from './latestCrowd';
import { TYPICAL_SOURCE } from './typicalOccupancy';

const reading = (venueId: string) => ({
  id: `c_${venueId}`, venueId, level: 3, label: 'Busy', waitMins: 15, source: 'user_report', recordedAt: new Date('2026-10-26T20:00:00Z'),
});

test('Each venue gets only its newest reading, from one query, in the shape the include returned', async () => {
  const asked: unknown[] = [];
  (db.mapReport as any).findMany = async () => [];
  (db as any).$queryRaw = async (_sql: TemplateStringsArray, ...values: unknown[]) => {
    asked.push(values[0]);
    return [reading('v1')];
  };

  const venues = await withLatestCrowd([{ id: 'v1', name: 'One' }, { id: 'v2', name: 'Two' }]);

  assert.deepEqual(asked, [['v1', 'v2']]);
  assert.deepEqual(venues, [
    { id: 'v1', name: 'One', crowdLevels: [reading('v1')] },
    // A venue with no readings keeps the empty list, so `crowdLevels[0]` stays null-safe.
    { id: 'v2', name: 'Two', crowdLevels: [] },
  ]);

  asked.length = 0;
  assert.deepEqual(await withLatestCrowd([]), []);
  assert.equal(asked.length, 0);
});

test('Cleanup deletes only typical rows past retention; live reports are kept', async () => {
  let where: any;
  (db.crowdLevel as any).deleteMany = async (args: { where: unknown }) => {
    where = args.where;
    return { count: 7 };
  };
  const now = new Date('2026-10-26T12:00:00Z');

  assert.equal(await pruneTypicalCrowd(now), 7);
  assert.deepEqual(where, { source: TYPICAL_SOURCE, recordedAt: { lt: new Date(now.getTime() - TYPICAL_RETENTION_MS) } });
  // The longest history read is 24 readings, six hours at the 15-minute cadence.
  assert.ok(TYPICAL_RETENTION_MS >= 24 * 15 * 60 * 1000);
});

test('No venue read goes back to a nested crowdLevels include', () => {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) sources.push(path);
    }
  };
  walk(join(__dirname, '..'));

  const offenders = sources.filter((path) => /crowdLevels:\s*\{/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

// withLatestCrowd reads the real clock, so fixtures are relative to it.
const NOW = new Date();
const row = (id: string, level: number, source: string, minutesAgo: number) => ({
  id, venueId: 'v1', level, label: ['', 'Chill', 'Active', 'Busy', 'Packed'][level], waitMins: null, source,
  recordedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
});

test('A fresh live reading beats a newer typical one; the highest live level wins; stale live falls back', () => {
  assert.equal(currentCrowd([row('t', 1, TYPICAL_SOURCE, 2), row('c', 2, 'user_report', 10)], NOW)?.id, 'c');
  assert.equal(currentCrowd([row('c', 2, 'user_report', 2), row('r', 4, 'user_report', 20)], NOW)?.id, 'r');
  assert.equal(currentCrowd([row('t', 1, TYPICAL_SOURCE, 2), row('c', 3, 'user_report', LIVE_CROWD_FRESH_MS / 60_000 + 1)], NOW)?.id, 't');
  assert.equal(currentCrowd([], NOW), undefined);
});

test('A confirmed packed report is the venue reading until it ends; unconfirmed, removed and other kinds are not asked for', async () => {
  let where: any;
  (db.mapReport as any).findMany = async (args: { where: unknown }) => {
    where = args.where;
    return [{ id: 'rep1', venueId: 'v1', kind: 'packed', confirmedAt: new Date(NOW.getTime() - 5 * 60_000) }];
  };
  (db as any).$queryRaw = async () => [row('t', 1, TYPICAL_SOURCE, 1)];
  const [venue] = await withLatestCrowd([{ id: 'v1' }]);
  assert.equal(venue.crowdLevels[0].level, 4);
  assert.equal(venue.crowdLevels[0].label, 'Packed');
  assert.equal(venue.crowdLevels[0].source, 'user_report');
  assert.equal(venue.crowdLevels[0].waitMins, null);
  assert.deepEqual(where.kind, { in: ['packed', 'long_line'] });
  assert.deepEqual(where.confirmedAt, { not: null });
  assert.equal(where.removedAt, null);
  assert.ok(where.expiresAt.gt instanceof Date);

  (db.mapReport as any).findMany = async () => { throw new Error('down'); };
  const [fallback] = await withLatestCrowd([{ id: 'v1' }]);
  assert.equal(fallback.crowdLevels[0].id, 't', 'a report read failure never fails the crowd read');
});

test('Venue history puts the shown reading first and keeps the rest newest first', async () => {
  (db.crowdLevel as any).findMany = async () => [row('t2', 1, TYPICAL_SOURCE, 1), row('c', 3, 'user_report', 8), row('t1', 1, TYPICAL_SOURCE, 16)];
  (db.mapReport as any).findMany = async () => [];
  assert.deepEqual((await recentCrowd('v1', 24, NOW)).map((r) => r.id), ['c', 't2', 't1']);
  (db.mapReport as any).findMany = async () => [{ id: 'rep', venueId: 'v1', kind: 'long_line', confirmedAt: new Date(NOW.getTime() - 60_000) }];
  const withReport = await recentCrowd('v1', 2, NOW);
  assert.deepEqual(withReport.map((r) => [r.id, r.label]), [['report:rep', 'Busy'], ['t2', 'Chill']], 'equal levels: the newer reading wins; never more than take');
});
