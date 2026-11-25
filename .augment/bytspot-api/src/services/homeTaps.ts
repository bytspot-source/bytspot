import { db } from '../lib/db';
import { captureError } from '../lib/observability';

/** The Home screen's blocks, as the app names them. The table refuses anything else. */
export const HOME_BLOCKS = ['todays_pick', 'start_here', 'near_you_now', 'weather', 'music', 'explore', 'tonight_events', 'local_services'] as const;
export type HomeBlock = (typeof HOME_BLOCKS)[number];

/** Counts one tap on a Home block. No user, device or target is stored; a failure never reaches the app. */
export async function noteHomeTap(block: HomeBlock, write: (block: HomeBlock) => Promise<unknown> = (b) => db.homeTap.create({ data: { block: b } })): Promise<void> {
  try {
    await write(block);
  } catch (err) {
    captureError(err, { route: 'home-tap' });
  }
}

/** Taps per block between `start` and `end`, every block present. */
export async function homeTapCounts(start: Date, end: Date): Promise<Record<HomeBlock, number>> {
  const rows = await db.homeTap.groupBy({ by: ['block'], where: { tappedAt: { gte: start, lt: end } }, _count: { _all: true } });
  const counts = Object.fromEntries(HOME_BLOCKS.map((block) => [block, 0])) as Record<HomeBlock, number>;
  for (const row of rows) if ((HOME_BLOCKS as readonly string[]).includes(row.block)) counts[row.block as HomeBlock] = row._count._all;
  return counts;
}
