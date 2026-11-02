import { TYPICAL_SOURCE, typicalCrowd } from '../../services/typicalOccupancy';
import type { CrowdPort } from '../ports/types';

/** Hour (0–23) and weekday (0=Sun) of an instant in Atlanta. */
export function atlantaHourAndDay(iso: string): { hour: number; dayOfWeek: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { hour, dayOfWeek };
}

/**
 * CrowdPort over typicalOccupancy.ts: what a place is usually like at the plan
 * hour. Typical only — live readings are not read here, so a plan can never
 * show a live label from this port.
 */
export function createBackendCrowdPort(): CrowdPort {
  return {
    async typical(place, at) {
      const { hour, dayOfWeek } = atlantaHourAndDay(at);
      const crowd = typicalCrowd(hour, dayOfWeek, place.types[0] ?? place.name);
      return { level: crowd.level, source: TYPICAL_SOURCE };
    },
  };
}
