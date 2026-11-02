import { z } from 'zod';
import { crowdInfo } from '../core/crowd';
import { distanceMeters, milesToMeters } from '../core/geo';
import { minutesBetween } from '../core/time';
import type { Ports } from '../ports/types';
import { defineSkill, isoDateTime, statusSchema } from './types';

/** CrowdPort is Typical-only: whatever it returns is labeled typical, never live. */
async function typicalFromPort(ports: Ports, place: { placeId: string; name: string; types: string[] }, at: string) {
  if (!ports.crowd) return null;
  try {
    const reading = await ports.crowd.typical({ placeId: place.placeId, name: place.name, types: place.types }, at);
    return reading ? crowdInfo({ level: reading.level, source: 'typical' }) : null;
  } catch { return null; }
}

export const DISCOVERY_NEEDS = ['dining', 'drinks', 'nightlife', 'event', 'coffee', 'activity'] as const;

export const candidateSchema = z.object({
  id: z.string(),
  kind: z.enum(['place', 'event']),
  needKind: z.string(),
  name: z.string(),
  placeId: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  distanceMeters: z.number(),
  rating: z.number().nullable(),
  isOpen: z.boolean().nullable(),
  /** Per person. Null = unknown. */
  priceCents: z.number().int().nullable(),
  priceBasis: z.enum(['bytspot_bookable', 'provider_listed', 'estimate']).nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  durationMins: z.number().int().nullable(),
  capacity: z.number().int().nullable(),
  /** Smallest party the supply runs for, when it states one. Null = no stated minimum. */
  minParty: z.number().int().nullable(),
  bookableId: z.string().nullable(),
  /** book | request | details (bookableProjection). Places are details until bookables says otherwise. */
  capability: z.enum(['book', 'request', 'details']),
  crowd: z.object({ level: z.number(), source: z.enum(['typical', 'live']), label: z.string(), observedAt: z.string().nullable() }).nullable(),
});
export type Candidate = z.infer<typeof candidateSchema>;

const input = z.object({
  needKind: z.enum(DISCOVERY_NEEDS).describe('What kind of stop to find.'),
  query: z.string().min(1).max(200).describe('Search text, e.g. "southern food" or "rooftop cocktail bar".'),
  latitude: z.number().min(-90).max(90).optional().describe('Defaults to the request area.'),
  longitude: z.number().min(-180).max(180).optional(),
  radiusMiles: z.number().positive().max(25).optional(),
  startsAt: isoDateTime.optional().describe('For events: window start.'),
  endsAt: isoDateTime.optional(),
  maxResults: z.number().int().min(1).max(10).default(5),
});
const output = z.object({
  status: statusSchema, message: z.string().nullable(), candidates: z.array(candidateSchema),
  /** Places the guest's saved preferences left out of this search. */
  leftOut: z.number().int().min(0),
});

export const discoverySkill = defineSkill({
  name: 'discovery',
  description: 'Find real places (and Bytspot events) near the area for one kind of stop. Returns candidates with ids, per-person price if known (with basis), and crowd labeled typical or live. Only these candidates may appear in a plan.',
  input, output,
  async run(args, { ports, defaults, now }) {
    const latitude = args.latitude ?? defaults.latitude;
    const longitude = args.longitude ?? defaults.longitude;
    const radiusMeters = milesToMeters(args.radiusMiles ?? defaults.radiusMiles);
    const center = { latitude, longitude };
    const candidates: Candidate[] = [];
    let status: z.infer<typeof statusSchema> = 'ok';
    const messages: string[] = [];
    let leftOut = 0;

    if (args.needKind === 'event' || args.needKind === 'nightlife') {
      try {
        const found = await ports.events.search({ latitude, longitude, radiusMeters, startsAt: args.startsAt ?? defaults.startsAt, endsAt: args.endsAt ?? defaults.endsAt, query: args.query });
        if (found.source === 'unavailable') { status = 'unavailable'; messages.push('Bytspot events are unavailable right now.'); }
        for (const e of found.events) {
          const d = distanceMeters(center, e);
          if (d > radiusMeters) continue;
          candidates.push({
            id: `event:${e.id}`, kind: 'event', needKind: 'event', name: `${e.title} at ${e.venueName}`, placeId: e.placeId, address: e.address,
            latitude: e.latitude, longitude: e.longitude, distanceMeters: Math.round(d), rating: null, isOpen: null,
            priceCents: e.priceCents, priceBasis: e.priceCents === null ? null : e.bookableId ? 'bytspot_bookable' : 'provider_listed',
            startsAt: e.startsAt, endsAt: e.endsAt, durationMins: e.endsAt ? minutesBetween(e.startsAt, e.endsAt) : null,
            capacity: e.capacity, minParty: e.minParty ?? null, bookableId: e.bookableId, capability: e.capability, crowd: null,
          });
        }
      } catch { status = 'unavailable'; messages.push('Bytspot events are unavailable right now.'); }
    }

    if (args.needKind !== 'event') {
      try {
        const found = await ports.places.search({ query: args.query, needKind: args.needKind, latitude, longitude, radiusMeters });
        leftOut = found.leftOut ?? 0;
        if (found.source === 'unavailable') { status = 'unavailable'; messages.push(`Place search is unavailable right now, so I can't suggest ${args.needKind} spots.`); }
        else if (found.source === 'google-stale') { if (status === 'ok') status = 'stale'; messages.push('Place results are cached and may be out of date; open/closed is not shown.'); }
        for (const p of found.places) {
          const d = distanceMeters(center, p);
          if (d > radiusMeters) continue; // never trust the port's radius
          candidates.push({
            id: `place:${p.placeId}`, kind: 'place', needKind: args.needKind, name: p.name, placeId: p.placeId, address: p.address,
            latitude: p.latitude, longitude: p.longitude, distanceMeters: Math.round(d), rating: p.rating,
            isOpen: found.source === 'google-stale' ? null : p.isOpen,
            priceCents: p.priceCents, priceBasis: p.priceCents === null ? null : p.priceBasis,
            startsAt: null, endsAt: null, durationMins: null, capacity: null, minParty: null, bookableId: null, capability: 'details',
            crowd: crowdInfo(p.crowd, now) ?? await typicalFromPort(ports, p, args.startsAt ?? defaults.startsAt ?? now),
          });
        }
      } catch { status = 'unavailable'; messages.push(`Place search is unavailable right now, so I can't suggest ${args.needKind} spots.`); }
    }

    candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
    if (status === 'ok' && candidates.length === 0) status = 'none';
    return { status, message: messages.join(' ') || null, candidates: candidates.slice(0, args.maxResults), leftOut };
  },
});
