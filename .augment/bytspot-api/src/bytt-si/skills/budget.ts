import { z } from 'zod';
import { evaluateBudget } from '../core/budget';
import { defineSkill } from './types';

const input = z.object({
  partySize: z.number().int().min(1).max(50).optional().describe('Defaults to the request party size.'),
  budgetCents: z.number().int().min(0).optional().describe('Total ceiling for the whole group, in cents.'),
  stops: z.array(z.object({
    title: z.string(),
    priceCents: z.number().int().min(0).nullable().describe('Per person, from a discovery candidate. Null if unknown.'),
    priceBasis: z.enum(['bytspot_bookable', 'provider_listed', 'estimate']).nullable(),
  })),
});
const output = z.object({
  verdict: z.enum(['fits', 'breaks', 'unknown']),
  budgetCents: z.number().nullable(), perPersonCents: z.number().nullable(), totalCents: z.number().nullable(),
  basis: z.enum(['exact', 'estimate', 'unknown']), detail: z.string(),
});

export const budgetSkill = defineSkill({
  name: 'budget',
  description: 'Add up per-person prices for a set of stops against the group budget (total ceiling). Returns fits / breaks / unknown. Unknown prices stay unknown.',
  input, output,
  async run(args, { defaults }) {
    return evaluateBudget(args.stops, args.partySize ?? defaults.partySize, args.budgetCents ?? defaults.budgetCents);
  },
});
