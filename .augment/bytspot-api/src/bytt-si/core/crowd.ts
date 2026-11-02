import type { CrowdReading } from '../ports/types';
import type { CrowdInfo } from '../types';
import { clockLabel } from './time';

/** Same live sources as bytspot-api typicalOccupancy.ts LIVE_OCCUPANCY_SOURCES. */
export const LIVE_OCCUPANCY_SOURCES = ['bytspot', 'user_report', 'sensor'] as const;
export const isLiveSource = (source: string | null | undefined) => LIVE_OCCUPANCY_SOURCES.includes(source as never);

/** Same scale as bytspot-api TYPICAL_LABELS. */
const LEVEL_WORDS: Record<number, string> = { 0: 'quiet', 1: 'chill', 2: 'active', 3: 'busy', 4: 'packed' };

/**
 * The only place crowd labels are written. A reading is live only when the
 * backend marks a live source AND gives an observation time no older than
 * LIVE_MAX_AGE_MINS before `now`; everything else
 * is labeled typical, whatever the model says.
 */
export const LIVE_MAX_AGE_MINS = 30;

export function crowdInfo(reading: CrowdReading | null | undefined, now?: string): CrowdInfo | null {
  if (!reading || !Number.isFinite(reading.level)) return null;
  const level = Math.max(0, Math.min(4, Math.round(reading.level)));
  const word = LEVEL_WORDS[level];
  const age = reading.observedAt && now ? (new Date(now).getTime() - new Date(reading.observedAt).getTime()) / 60_000 : null;
  const fresh = age === null ? !now : age >= 0 && age <= LIVE_MAX_AGE_MINS;
  if (isLiveSource(reading.source) && reading.observedAt && fresh) {
    return { level, source: 'live', label: `Live: ${word} as of ${clockLabel(reading.observedAt)}`, observedAt: reading.observedAt };
  }
  return { level, source: 'typical', label: `Usually ${word} around this time (typical, not live)`, observedAt: null };
}
