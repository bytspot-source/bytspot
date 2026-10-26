import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { db } from '../lib/db';
import { pruneTypicalCrowd, TYPICAL_RETENTION_MS, withLatestCrowd } from './latestCrowd';
import { TYPICAL_SOURCE } from './typicalOccupancy';

const reading = (venueId: string) => ({
  id: `c_${venueId}`, venueId, level: 3, label: 'Busy', waitMins: 15, source: 'user_report', recordedAt: new Date('2026-10-26T20:00:00Z'),
});

test('Each venue gets only its newest reading, from one query, in the shape the include returned', async () => {
  const asked: unknown[] = [];
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
