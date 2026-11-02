import { TIMEZONE } from '../types';

export const clockLabel = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const addMinutes = (iso: string, minutes: number) => new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
export const minutesBetween = (from: string, to: string) => Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
export const roundUpTo5 = (minutes: number) => Math.ceil(minutes / 5) * 5;
