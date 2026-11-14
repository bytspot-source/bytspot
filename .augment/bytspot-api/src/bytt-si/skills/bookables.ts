import { z } from 'zod';
import { BOOKING_PROVIDER_IDS } from '../../services/bookingProviders';
import { isValidTableLink } from '../core/deepLinks';
import { defineSkill, statusSchema } from './types';

const input = z.object({
  placeId: z.string().min(1).describe('placeId from a discovery candidate.'),
  partySize: z.number().int().min(1).max(50).optional(),
});
const output = z.object({
  status: statusSchema,
  message: z.string(),
  bytspot: z.array(z.object({
    kind: z.literal('bytspot'), bookableId: z.string(), capability: z.string(), tierName: z.string(),
    priceCents: z.number().int(), capacity: z.number().int(), fitsParty: z.boolean().nullable(),
  })),
  deeplinks: z.array(z.object({
    kind: z.literal('deeplink'), provider: z.enum(BOOKING_PROVIDER_IDS), label: z.string(), url: z.string(), availabilityChecked: z.literal(false),
  })),
});

export const bookablesSkill = defineSkill({
  name: 'bookables',
  description: 'What can be booked for a place: Bytspot bookables (real supply, bookable in-app) and, where listed, an outside booking hand-off link (OpenTable, Resy, Tock, FareHarbor and the like). Hand-off links never mean a table is available.',
  input, output,
  async run(args, { ports, defaults }) {
    const partySize = args.partySize ?? defaults.partySize;
    try {
      const { bookables, tableLink } = await ports.bookables.forPlace(args.placeId.replace(/^places\//, ''));
      const bytspot = bookables
        .filter((b) => b.capability !== 'details') // a details row is a reference, never a booking
        .map((b) => ({ kind: 'bytspot' as const, bookableId: b.id, capability: b.capability, tierName: b.tierName, priceCents: b.priceCents, capacity: b.capacity, fitsParty: partySize ? b.capacity >= partySize : null }));
      const deeplinks = tableLink && isValidTableLink(tableLink.provider, tableLink.url)
        ? [{ kind: 'deeplink' as const, provider: tableLink.provider, label: tableLink.label, url: tableLink.url.trim(), availabilityChecked: false as const }] : [];
      const message = bytspot.length ? 'Bookable in Bytspot.'
        : deeplinks.length ? `Book with ${deeplinks[0].label} via the link; availability is not checked.` : 'Nothing to book here; walk-in or check with the venue.';
      return { status: bytspot.length || deeplinks.length ? 'ok' as const : 'none' as const, message, bytspot, deeplinks };
    } catch {
      return { status: 'unavailable' as const, message: 'Booking info is unavailable right now.', bytspot: [], deeplinks: [] };
    }
  },
});
