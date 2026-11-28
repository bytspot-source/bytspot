import { z } from 'zod';
import { guestTravelLine, knownDriveMinutes } from '../../services/travelCopy';
import { rideLinks } from '../core/deepLinks';
import { distanceMeters, estimateTravel, travelModeFor } from '../core/geo';
import { defineSkill, latLngSchema, statusSchema } from './types';

const input = z.object({
  from: latLngSchema.optional().describe('Defaults to the request area.'),
  to: latLngSchema.extend({ name: z.string().min(1), address: z.string().nullable().optional() }),
  driveMinutes: z.number().int().min(0).max(180).optional().describe('MapKit drive time in minutes from the guest\'s phone. Omit when unknown. Do not guess.'),
});
const output = z.object({
  status: statusSchema,
  message: z.string(),
  travel: z.object({
    minutes: z.number(),
    meters: z.number(),
    mode: z.enum(['walk', 'drive']),
    basis: z.enum(['provider', 'estimate', 'apple_maps']),
    line: z.string(),
  }).nullable(),
  rideLinks: z.array(z.object({ provider: z.enum(['uber', 'lyft']), url: z.string(), fareChecked: z.literal(false) })),
});

export const routingSkill = defineSkill({
  name: 'routing',
  description: 'Travel time between two points (walk if close, else drive) plus Uber and Lyft hand-off links. A straight-line result is "about N min (estimate)". Pass driveMinutes only for a MapKit drive already on the phone; that time is preferred and labeled "Apple Maps estimate". Never quote an unlabeled minute count. Links are deep links only: no fares or ETAs are checked.',
  input, output,
  async run(args, { ports, defaults }) {
    const from = args.from ?? { latitude: defaults.latitude, longitude: defaults.longitude };
    const destination = { latitude: args.to.latitude, longitude: args.to.longitude, name: args.to.name, address: args.to.address ?? null };
    const links = ports.routing.rideLinks?.(destination) ?? rideLinks(destination);
    const mode = travelModeFor(distanceMeters(from, args.to));
    const note = 'Uber/Lyft are hand-off links; fares and availability are not checked.';
    const mapkit = knownDriveMinutes(args.driveMinutes);
    const apple = (meters: number) => {
      const line = guestTravelLine(mapkit!, 'apple_maps');
      return {
        status: 'ok' as const,
        message: `${line}. ${note}`,
        travel: { minutes: mapkit!, meters, mode, basis: 'apple_maps' as const, line },
        rideLinks: links,
      };
    };
    try {
      const est = await ports.routing.travel(from, args.to, mode);
      if (mapkit !== null) return apple(est?.meters ?? estimateTravel(from, args.to).meters);
      if (!est) return { status: 'none' as const, message: `Travel time unavailable. ${note}`, travel: null, rideLinks: links };
      const line = est.basis === 'estimate' ? guestTravelLine(est.minutes, 'estimate') : `${est.minutes} min`;
      return { status: 'ok' as const, message: `${line}. ${note}`, travel: { ...est, mode, line }, rideLinks: links };
    } catch {
      if (mapkit !== null) return apple(estimateTravel(from, args.to).meters);
      return { status: 'unavailable' as const, message: `Travel time unavailable. ${note}`, travel: null, rideLinks: links };
    }
  },
});
