import { z } from 'zod';
import { bestTimeSpeech } from '../core/crowd';
import { bestTimeToGo, type BestTimeToGo } from '../../services/bestTimeToGo';
import { defineSkill, isoDateTime, statusSchema } from './types';

const crowdInput = z.object({
  level: z.number(),
  source: z.string(),
  observedAt: z.string().min(1),
  label: z.string().optional(),
}).describe('Only a live reading a skill already returned. Omit it otherwise. Do not invent one.');

const input = z.object({
  name: z.string().min(1).max(120).describe('Place name, as the guest said it or as discovery returned it.'),
  category: z.string().min(1).max(80).describe('Venue category or place type, such as bar, restaurant, or coffee.'),
  slug: z.string().min(1).max(160).describe('Stable place id or slug from discovery. Used only to vary the usual pattern. Do not invent a place.'),
  startsAt: isoDateTime.optional().describe('Arrival window start. Defaults to the plan window, or now.'),
  endsAt: isoDateTime.optional().describe('Arrival window end. Defaults to the plan window, or six hours after the start.'),
  slotMinutes: z.union([z.literal(15), z.literal(30)]).optional(),
  driveMinutes: z.number().int().min(0).max(180).optional().describe('Known drive time in minutes. Omit when unknown. Do not guess.'),
  crowd: crowdInput.optional(),
});

const slotSchema = z.object({
  arrivalAt: z.string(),
  level: z.number().int().min(1).max(4),
  label: z.string(),
  waitMins: z.number().int().min(0),
  driveMinutes: z.number().int().min(0).optional(),
  leaveBy: z.string().optional(),
});

const output = z.object({
  status: statusSchema,
  source: z.literal('typical'),
  name: z.string(),
  summary: z.string(),
  /** Sentence to say. Typical estimate, plus a right-now line only when rightNow is set. */
  message: z.string(),
  driveMinutes: z.number().int().nullable(),
  preferredArrivalAt: z.string().nullable(),
  preferredLeaveBy: z.string().nullable(),
  slots: z.array(slotSchema),
  rightNow: z.object({
    level: z.number().int(),
    label: z.string(),
    source: z.string(),
    recordedAt: z.string(),
    line: z.string(),
  }).nullable(),
});

function unavailable(name: string) {
  return {
    status: 'unavailable' as const,
    source: 'typical' as const,
    name,
    summary: 'A typical arrival estimate is unavailable right now.',
    message: 'A typical arrival estimate is unavailable right now.',
    driveMinutes: null,
    preferredArrivalAt: null,
    preferredLeaveBy: null,
    slots: [],
    rightNow: null,
  };
}

export const bestTimeToGoSkill = defineSkill({
  name: 'best_time_to_go',
  description: 'When to arrive at one place, from the usual pattern for that hour in Atlanta. Returns ranked arrival slots, a typical level (1-4) and label, typical wait, and one summary such as "Typically quieter before 9:30 PM (estimate)". This is an estimate, never a live count. Leave-by is included only when driveMinutes is passed. Say "right now" only from rightNow, and never say the place is empty right now from this estimate.',
  input, output,
  async run(args, { ports, defaults, now }) {
    const startsAt = new Date(args.startsAt ?? defaults.startsAt ?? now);
    const endsAt = new Date(args.endsAt ?? defaults.endsAt ?? new Date(startsAt.getTime() + 6 * 60 * 60 * 1000).toISOString());
    const live = args.crowd
      ? { level: args.crowd.level, label: args.crowd.label ?? null, source: args.crowd.source, recordedAt: args.crowd.observedAt }
      : null;
    try {
      const estimate: BestTimeToGo = ports.crowd?.bestTime
        ? await ports.crowd.bestTime({
          category: args.category,
          slug: args.slug,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          slotMinutes: args.slotMinutes,
          driveMinutes: args.driveMinutes ?? null,
          live: live ? { level: live.level, source: live.source, recordedAt: new Date(live.recordedAt).toISOString(), label: live.label } : null,
          now,
        })
        : bestTimeToGo({
          venue: { category: args.category, slug: args.slug },
          window: { startsAt, endsAt },
          slotMinutes: args.slotMinutes,
          driveMinutes: args.driveMinutes ?? null,
          live,
          now: new Date(now),
        });
      const message = bestTimeSpeech(estimate);
      return {
        status: estimate.slots.length ? 'ok' as const : 'none' as const,
        source: 'typical' as const,
        name: args.name,
        summary: estimate.summary,
        message,
        driveMinutes: estimate.driveMinutes,
        preferredArrivalAt: estimate.preferredArrivalAt,
        preferredLeaveBy: estimate.preferredLeaveBy,
        slots: estimate.slots,
        rightNow: estimate.rightNow,
      };
    } catch {
      return unavailable(args.name);
    }
  },
});
