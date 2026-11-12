import { TIMEZONE } from '../types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export interface AtlantaClock {
  hour: number;
  dayOfWeek: number;
  weekday: string;
}

/** Wall clock in America/New_York. hour is 0–23, dayOfWeek is 0 (Sunday) through 6. */
export function atlantaClock(now: Date): AtlantaClock {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (!Number.isFinite(hour)) hour = 0;
  if (hour === 24) hour = 0;
  const weekday = parts.weekday ?? 'Sun';
  const dayOfWeek = WEEKDAYS.indexOf(weekday as typeof WEEKDAYS[number]);
  return { hour: ((hour % 24) + 24) % 24, dayOfWeek: dayOfWeek < 0 ? 0 : dayOfWeek, weekday };
}

export function hourPhrase(hour: number, nowHour: number): string {
  if (hour === nowHour) return 'around this hour';
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `around ${shown} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The hour the night-out chip is about: the current hour once it's evening, otherwise 10 PM. */
export function nightPlanHour(hour: number): number {
  if (hour >= 17 || hour < 5) return hour;
  return 22;
}
