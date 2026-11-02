import { z } from 'zod';
import { rideLinks } from '../core/deepLinks';
import { distanceMeters, travelModeFor } from '../core/geo';
import { defineSkill, latLngSchema, statusSchema } from './types';

const input = z.object({
  from: latLngSchema.optional().describe('Defaults to the request area.'),
  to: latLngSchema.extend({ name: z.string().min(1), address: z.string().nullable().optional() }),
});
const output = z.object({
  status: statusSchema,
  message: z.string(),
  travel: z.object({ minutes: z.number(), meters: z.number(), mode: z.enum(['walk', 'drive']), basis: z.enum(['provider', 'estimate']) }).nullable(),
  rideLinks: z.array(z.object({ provider: z.enum(['uber', 'lyft']), url: z.string(), fareChecked: z.literal(false) })),
});

export const routingSkill = defineSkill({
  name: 'routing',
  description: 'Travel time between two points (walk if close, else drive) plus Uber and Lyft hand-off links. Links are deep links only: no fares or ETAs are checked.',
  input, output,
  async run(args, { ports, defaults }) {
    const from = args.from ?? { latitude: defaults.latitude, longitude: defaults.longitude };
    const destination = { latitude: args.to.latitude, longitude: args.to.longitude, name: args.to.name, address: args.to.address ?? null };
    const links = ports.routing.rideLinks?.(destination) ?? rideLinks(destination);
    const mode = travelModeFor(distanceMeters(from, args.to));
    const note = 'Uber/Lyft are hand-off links; fares and availability are not checked.';
    try {
      const est = await ports.routing.travel(from, args.to, mode);
      if (!est) return { status: 'none' as const, message: `No travel estimate. ${note}`, travel: null, rideLinks: links };
      return { status: 'ok' as const, message: note, travel: { ...est, mode }, rideLinks: links };
    } catch {
      return { status: 'unavailable' as const, message: `Routing is unavailable right now. ${note}`, travel: null, rideLinks: links };
    }
  },
});
