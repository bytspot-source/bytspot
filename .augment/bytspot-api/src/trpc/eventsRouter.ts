/**
 * Events sub-router — Phase 2: Events API
 * Proxies and caches Ticketmaster Discovery API for Atlanta area events.
 * Returns an empty list when Ticketmaster is not configured.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createHash, createHmac, randomInt } from 'node:crypto';
import Stripe from 'stripe';
import { router, publicProcedure, protectedProcedure, rateLimitMiddleware, stripeWebhookProcedure } from './trpc';
import { cached } from '../lib/redis';
import { config } from '../config';
import { db } from '../lib/db';
import { uploadPartyImage } from '../lib/cloudinary';

// ─── Ticketmaster Discovery API helpers ─────────────────────────────
const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';

interface TmEvent {
  id: string;
  name: string;
  url: string;
  dates?: { start?: { localDate?: string; localTime?: string } };
  priceRanges?: Array<{ min: number; max: number; currency: string }>;
  images?: Array<{ url: string; width: number; ratio: string }>;
  classifications?: Array<{ segment?: { name: string }; genre?: { name: string } }>;
  _embedded?: { venues?: Array<{ name: string; city?: { name: string }; address?: { line1: string } }> };
}

export function mapTmEvent(e: TmEvent) {
  const venue = e._embedded?.venues?.[0];
  const img = e.images?.find((i) => i.ratio === '16_9' && i.width >= 500) ?? e.images?.[0];
  const price = e.priceRanges?.[0];
  const genre = e.classifications?.[0]?.genre?.name ?? e.classifications?.[0]?.segment?.name ?? 'event';
  const categoryMap: Record<string, string> = {
    Jazz: 'concert', Rock: 'concert', Pop: 'concert', 'Hip-Hop/Rap': 'concert', 'R&B': 'concert',
    Comedy: 'comedy', Arts: 'art', Theatre: 'art', Sports: 'sports', Food: 'food',
  };
  return {
    id: e.id,
    title: e.name,
    venue: venue?.name ?? 'Atlanta Venue',
    date: e.dates?.start?.localDate ?? 'TBD',
    time: e.dates?.start?.localTime?.slice(0, 5) ?? 'TBD',
    category: categoryMap[genre] ?? 'concert',
    emoji: categoryEmoji(categoryMap[genre] ?? 'concert'),
    price: price ? (price.min === 0 ? 'Free' : `$${price.min}`) : 'See link',
    image: img?.url ?? 'https://images.unsplash.com/photo-1415201364774-f6f0bb35f28f?w=600',
    url: e.url,
  };
}

function categoryEmoji(cat: string): string {
  const map: Record<string, string> = {
    concert: '🎵', rooftop: '🌃', happyhour: '🍺', comedy: '😂',
    art: '🎨', food: '🍽️', sports: '⚽',
  };
  return map[cat] ?? '🎉';
}

const membershipTier = z.enum(['green', 'platinum', 'black']);
const tierRank = { green: 0, platinum: 1, black: 2 } as const;
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const partyTemplateId = z.enum(['listening-party', 'comedy-night', 'premiere', 'private-party', 'fan-meetup', 'release-party', 'pop-up']);
const partyTemplateConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standard') }).strict(),
  z.object({ kind: z.literal('listening-party'), format: z.enum(['listening-session', 'dj-mix-premiere', 'live-performance', 'label-showcase']) }).strict(),
  z.object({ kind: z.literal('fan-meetup'), format: z.enum(['meet-and-greet', 'creator-conversation', 'community-photo']) }).strict(),
  z.object({ kind: z.literal('release-party'), releaseType: z.enum(['single', 'ep', 'album', 'mix', 'video']), releaseTitle: z.string().trim().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('pop-up'), locationDisclosure: z.enum(['public', 'after-approval']) }).strict(),
  z.object({ kind: z.literal('private-party'), guestPolicy: z.enum(['named-guests', 'named-guests-plus-one']) }).strict(),
]);
const templateConfigKind: Record<z.infer<typeof partyTemplateId>, z.infer<typeof partyTemplateConfig>['kind']> = {
  'listening-party': 'listening-party',
  'fan-meetup': 'fan-meetup',
  'release-party': 'release-party',
  'pop-up': 'pop-up',
  'private-party': 'private-party',
  'comedy-night': 'standard',
  premiere: 'standard',
};
const partyPassAction = z.enum(['authenticate', 'rsvp', 'reserve-cash', 'ticket', 'request-approval', 'view-pass', 'unavailable']);
const partyPassPolicy = z.object({
  version: z.literal(1),
  before: z.object({ action: partyPassAction }).strict(),
  atDoor: z.object({ action: partyPassAction }).strict(),
  during: z.object({ action: partyPassAction }).strict(),
  after: z.object({ action: partyPassAction }).strict(),
}).strict();
const ticketTier = z.object({
  name: z.string().trim().min(1).max(80),
  priceCents: z.number().int().min(0).max(10_000_000),
  quantity: z.number().int().min(1).max(100_000),
  requiredMembershipTier: membershipTier,
});
const partyCreatorLinkKind = z.enum(['music', 'merchandise', 'website', 'social']);
const partyCreatorLink = z.object({
  kind: partyCreatorLinkKind,
  title: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(2_048).url(),
}).strict().superRefine((link, ctx) => {
  try {
    const url = new URL(link.url);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'Creator links must be credential-free HTTPS URLs.' });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'Creator links must be valid HTTPS URLs.' });
  }
});
const partyCreatorLinks = z.array(partyCreatorLink).max(8).superRefine((links, ctx) => {
  const seen = new Set<string>();
  links.forEach((link, index) => {
    let canonical = link.url;
    try { canonical = new URL(link.url).href; } catch { /* link-level validation reports malformed URLs */ }
    if (seen.has(canonical)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'url'], message: 'Each creator link may be added only once.' });
    }
    seen.add(canonical);
  });
});
const partyDraftInput = z.object({
  idempotencyKey,
  templateId: partyTemplateId,
  title: z.string().trim().min(3).max(200),
  tagline: z.string().trim().max(280),
  startsAt: z.string().datetime(),
  venueName: z.string().trim().min(1).max(200),
  capacity: z.number().int().min(2).max(100_000),
  accessMode: z.enum(['open-entry', 'free-rsvp', 'cash-at-door', 'paid-ticket', 'private-approval']),
  cashDoorPriceCents: z.number().int().min(1).max(10_000_000).nullable().optional(),
  requiredMembershipTier: membershipTier,
  audienceCircleIds: z.array(z.string().min(1).max(200)).max(100),
  itinerary: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    offsetMinutes: z.number().int().min(0).max(10_080),
  })).max(50),
  creatorLinks: partyCreatorLinks.default([]),
  ticketTiers: z.array(ticketTier).max(20),
  cohosts: z.array(z.object({
    email: z.string().trim().email().max(320).transform((email) => email.toLowerCase()),
    role: z.enum(['cohost', 'door', 'finance']),
  })).max(20),
  templateConfig: partyTemplateConfig,
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
  if (input.templateConfig.kind !== templateConfigKind[input.templateId]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateConfig', 'kind'], message: 'The template configuration does not match this Party template.' });
  }
  if (input.templateConfig.kind === 'private-party' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'Private Parties require host approval.' });
  }
  if (input.templateConfig.kind === 'pop-up' && input.templateConfig.locationDisclosure === 'after-approval' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'A hidden Pop-Up location requires host approval.' });
  }
  const paidTiers = input.ticketTiers.filter((tier) => tier.priceCents > 0);
  if (input.accessMode === 'paid-ticket' && paidTiers.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Paid parties require a paid ticket tier.' });
  }
  if (input.accessMode !== 'paid-ticket' && paidTiers.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Only paid parties may include paid ticket tiers.' });
  }
  if (input.accessMode === 'cash-at-door' && !input.cashDoorPriceCents) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cashDoorPriceCents'], message: 'Cash-at-door parties require a cash amount.' });
  }
  if (input.accessMode !== 'cash-at-door' && input.cashDoorPriceCents != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cashDoorPriceCents'], message: 'Only cash-at-door parties may include a cash amount.' });
  }
  if (input.ticketTiers.reduce((total, tier) => total + tier.quantity, 0) > input.capacity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Ticket inventory cannot exceed party capacity.' });
  }
  for (const [index, tier] of input.ticketTiers.entries()) {
    if (tierRank[tier.requiredMembershipTier] < tierRank[input.requiredMembershipTier]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers', index, 'requiredMembershipTier'], message: 'A ticket tier cannot bypass the party membership gate.' });
    }
  }
  const teammateEmails = input.cohosts.map((cohost) => cohost.email);
  if (new Set(teammateEmails).size !== teammateEmails.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cohosts'], message: 'Each teammate may be assigned only once.' });
  }
});

// Keep each JSON request below the server's 1 MB parser limit. The iOS client
// downsizes and recompresses selected images before sending them.
const imageDataUri = z.string().max(850_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/);
const partyMediaUploadInput = z.discriminatedUnion('kind', [
  z.object({ partyId: z.string().min(1).max(200), kind: z.literal('cover'), dataUri: imageDataUri }),
  z.object({ partyId: z.string().min(1).max(200), kind: z.literal('album'), index: z.number().int().min(0).max(5), dataUri: imageDataUri }),
]);
const partyAppleDiscoveryInput = z.object({
  partyId: z.string().min(1).max(200),
  idempotencyKey,
  // Coordinates are resolved only from a verified Venue row, never from a host device.
  venueId: z.string().min(1).max(200),
  card: z.object({
    title: z.string().trim().min(1).max(30),
    subtitle: z.string().trim().min(1).max(60),
  }).strict(),
}).strict();

type PartyDraftInput = z.infer<typeof partyDraftInput>;
type PartyPassPolicy = z.infer<typeof partyPassPolicy>;
type PartyPassAction = z.infer<typeof partyPassAction>;
type PartyAppleDiscoveryInput = z.infer<typeof partyAppleDiscoveryInput>;

const templateLabels: Record<string, string> = {
  'listening-party': 'Listening Party',
  'comedy-night': 'Comedy Night',
  premiere: 'Premiere',
  'private-party': 'Private Party',
  'fan-meetup': 'Fan Meetup',
  'release-party': 'Release Party',
  'pop-up': 'Pop-Up',
};

function draftFingerprint(input: PartyDraftInput): string {
  const { idempotencyKey: _key, ...draft } = input;
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}

function partyPassCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

function partyTouchpointReference(partyID: string): string {
  return `p1_${createHmac('sha256', config.jwtSecret).update(`party-touchpoint:${partyID}`).digest('base64url')}`;
}

function defaultPartyPassPolicy(accessMode: string): PartyPassPolicy {
  const action: PartyPassAction = accessMode === 'paid-ticket'
    ? 'ticket'
    : accessMode === 'cash-at-door'
      ? 'reserve-cash'
    : accessMode === 'private-approval'
      ? 'request-approval'
      : accessMode === 'open-entry'
        ? 'view-pass'
      : 'rsvp';
  return {
    version: 1,
    before: { action },
    atDoor: { action: accessMode === 'open-entry' ? 'view-pass' : 'unavailable' },
    during: { action: accessMode === 'open-entry' ? 'view-pass' : 'unavailable' },
    after: { action: accessMode === 'open-entry' ? 'view-pass' : 'unavailable' },
  };
}

function readPartyPassPolicy(value: unknown): PartyPassPolicy {
  const parsed = partyPassPolicy.safeParse(value);
  return parsed.success
    ? parsed.data
    : { version: 1, before: { action: 'unavailable' }, atDoor: { action: 'unavailable' }, during: { action: 'unavailable' }, after: { action: 'unavailable' } };
}

function partyLocationForPublicInvite(party: { venueName: string; templateId: string; templateConfig: unknown }) {
  const config = partyTemplateConfig.safeParse(party.templateConfig);
  const explicitlyPublicPopUp = config.success && config.data.kind === 'pop-up' && config.data.locationDisclosure === 'public';
  // A Pop-Up must opt in to public disclosure. Historic or malformed JSON must
  // never turn a hidden venue into a public one.
  const locationDisclosure = party.templateId === 'pop-up' && !explicitlyPublicPopUp ? 'after-approval' : 'public';
  return {
    locationDisclosure,
    locationLabel: locationDisclosure === 'after-approval' ? 'Location shared after approval' : party.venueName,
  };
}

/**
 * Template metadata controls App Clip presentation only. It must be parsed
 * again at the public boundary: corrupt historic JSON may not select a
 * privileged/incorrect Party layout.
 */
function publicPartyTemplate(party: { templateId: string; templateConfig: unknown }) {
  const templateId = partyTemplateId.safeParse(party.templateId);
  const templateConfig = partyTemplateConfig.safeParse(party.templateConfig);
  const isMatchingConfiguration = templateId.success
    && templateConfig.success
    && templateConfigKind[templateId.data] === templateConfig.data.kind;
  return {
    templateId: templateId.success ? templateId.data : null,
    templateConfig: isMatchingConfiguration ? templateConfig.data : null,
  };
}

function publicPartyTicketTiers(party: { accessMode: string; ticketTiers: unknown }) {
  if (party.accessMode !== 'paid-ticket') return [];
  const tiers = z.array(ticketTier).safeParse(party.ticketTiers);
  return tiers.success
    ? tiers.data.filter((tier) => tier.priceCents > 0).map(({ name, priceCents, quantity, requiredMembershipTier }) => ({ name, priceCents, quantity, requiredMembershipTier }))
    : [];
}

function partyTiming(startsAt: Date): 'now' | 'today' | 'thisWeek' {
  const delta = startsAt.getTime() - Date.now();
  if (Math.abs(delta) <= 2 * 60 * 60 * 1000) return 'now';
  if (delta <= 24 * 60 * 60 * 1000) return 'today';
  return 'thisWeek';
}

function itineraryTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const title = (item as { title?: unknown }).title;
    return typeof title === 'string' && title.trim() ? [title.trim()] : [];
  });
}

type PartyTier = z.infer<typeof membershipTier>;
const partyParticipationStatus = z.enum(['rsvp', 'pending', 'approved', 'declined', 'checked_in', 'cancelled']);

async function viewerPartyTier(userId: string): Promise<PartyTier> {
  const now = new Date();
  const [user, black] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { isPremium: true } }),
    (db as any).membershipEntitlement.findFirst({
      where: { userId, tier: 'black', status: 'active', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true },
    }),
  ]);
  if (black) return 'black';
  return user?.isPremium === true ? 'platinum' : 'green';
}

function partyTierAllows(viewerTier: PartyTier, requiredTier: string): boolean {
  return requiredTier in tierRank && tierRank[viewerTier] >= tierRank[requiredTier as PartyTier];
}

function canProvisionAppleDiscovery(tier: PartyTier): boolean {
  return tierRank[tier] >= tierRank.platinum;
}

function normalizedVenueName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function appleDiscoveryFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function appleDiscoveryJobResponse(job: any, fallbackShareUrl: string) {
  return {
    id: job.id,
    status: job.status,
    hostTier: job.hostTier,
    attemptCount: job.attemptCount,
    appleExperienceId: job.appleExperienceId ?? null,
    failureCode: job.failureCode ?? null,
    queuedAt: job.queuedAt?.toISOString?.() ?? null,
    lastAttemptAt: job.lastAttemptAt?.toISOString?.() ?? null,
    completedAt: job.completedAt?.toISOString?.() ?? null,
    fallback: { mode: 'standard-party-pass' as const, shareUrl: fallbackShareUrl },
  };
}

function partyLifecycle(startsAt: Date): 'before' | 'at-door' {
  return startsAt.getTime() > Date.now() ? 'before' : 'at-door';
}

function hasValidCashDoorAmount(party: { accessMode: string; cashDoorPriceCents?: unknown }): boolean {
  return party.accessMode !== 'cash-at-door' || (typeof party.cashDoorPriceCents === 'number' && Number.isInteger(party.cashDoorPriceCents) && party.cashDoorPriceCents > 0);
}

function actionForPartyViewer(args: {
  party: { startsAt: Date; accessMode: string; cashDoorPriceCents?: unknown; requiredMembershipTier: string };
  viewerTier: PartyTier;
  participation: { status: string } | null;
  isAuthenticated: boolean;
}): PartyPassAction {
  const { party, viewerTier, participation, isAuthenticated } = args;
  if (!partyTierAllows(viewerTier, party.requiredMembershipTier)) return 'unavailable';
  if (!hasValidCashDoorAmount(party)) return 'unavailable';
  if (party.accessMode === 'open-entry') return 'view-pass';
  if (partyLifecycle(party.startsAt) !== 'before') return 'unavailable';
  if (participation?.status === 'checked_in' || participation?.status === 'approved' || participation?.status === 'rsvp') return 'view-pass';
  if (participation?.status === 'pending' || participation?.status === 'declined' || participation?.status === 'cancelled') return 'unavailable';
  if (!isAuthenticated) return 'authenticate';
  if (party.accessMode === 'paid-ticket') return 'ticket';
  if (party.accessMode === 'cash-at-door') return 'reserve-cash';
  return party.accessMode === 'private-approval' ? 'request-approval' : 'rsvp';
}

async function resolvePartyPass(party: any, touchpoint: any, userId?: string) {
  if (!party || party.status !== 'published' || !touchpoint || touchpoint.status !== 'active') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
  }
  const viewerTier = userId ? await viewerPartyTier(userId) : 'green';
  const participation = userId
    ? await (db as any).partyParticipation.findUnique({ where: { partyId_userId: { partyId: party.id, userId } }, select: { status: true, checkedInAt: true } })
    : null;
  const action = actionForPartyViewer({ party, viewerTier, participation, isAuthenticated: Boolean(userId) });
  return {
    partyId: party.id,
    touchpoint: { reference: touchpoint.reference, kind: touchpoint.kind },
    lifecycle: partyLifecycle(party.startsAt),
    action,
    entitlement: { tier: viewerTier, requiredTier: party.requiredMembershipTier, granted: partyTierAllows(viewerTier, party.requiredMembershipTier) },
    guest: {
      status: participation?.status ?? (userId ? 'authenticated-unverified' : 'anonymous'),
      canStartPrimaryAction: action === 'rsvp' || action === 'reserve-cash' || action === 'ticket' || action === 'request-approval',
      accessGranted: action === 'view-pass',
    },
  };
}

function publishedParty(party: { id: string; status: string; passCode: string | null }) {
  if (party.status !== 'published' || !party.passCode) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Party Pass is unavailable.' });
  }
  return {
    id: party.id,
    status: 'published' as const,
    shareUrl: `https://bytspot.app/party/${encodeURIComponent(party.id)}`,
    passCode: party.passCode,
  };
}

function paidTicketTier(party: { ticketTiers: unknown; requiredMembershipTier: string }, tierName: string) {
  const tiers = z.array(ticketTier).safeParse(party.ticketTiers);
  const tier = tiers.success ? tiers.data.find((candidate) => candidate.name === tierName && candidate.priceCents > 0) : undefined;
  if (!tier || tierRank[tier.requiredMembershipTier] < tierRank[party.requiredMembershipTier as PartyTier]) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket tier not found.' });
  }
  return tier;
}

function publicPartyCreatorLinks(value: unknown) {
  const parsed = partyCreatorLinks.safeParse(value);
  return parsed.success ? parsed.data : [];
}

const partyDraftsRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:drafts:create' }))
    .input(partyDraftInput)
    .mutation(async ({ ctx, input }) => {
      const hostId = ctx.user.userId;
      if (input.cohosts.some((cohost) => cohost.email === ctx.user.email.toLowerCase())) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The party owner cannot also be assigned as a teammate.' });
      }
      const fingerprint = draftFingerprint(input);
      const party = await db.party.upsert({
        where: { hostId_idempotencyKey: { hostId, idempotencyKey: input.idempotencyKey } },
        create: {
          hostId,
          idempotencyKey: input.idempotencyKey,
          draftFingerprint: fingerprint,
          templateId: input.templateId,
          title: input.title,
          tagline: input.tagline,
          startsAt: new Date(input.startsAt),
          venueName: input.venueName,
          capacity: input.capacity,
          accessMode: input.accessMode,
          cashDoorPriceCents: input.cashDoorPriceCents ?? null,
          requiredMembershipTier: input.requiredMembershipTier,
          audienceCircleIds: input.audienceCircleIds,
          creatorLinks: input.creatorLinks,
          itinerary: input.itinerary,
          ticketTiers: input.ticketTiers,
          cohosts: input.cohosts,
          templateConfig: input.templateConfig,
          source: input.source,
        },
        update: {},
      });
      if (party.draftFingerprint !== fingerprint) {
        throw new TRPCError({ code: 'CONFLICT', message: 'That idempotency key belongs to a different party draft.' });
      }
      return { id: party.id, status: party.status };
    }),
});

const partyMediaRouter = router({
  reset: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:media:reset' }))
    .input(z.object({ partyId: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findUnique({ where: { id: input.partyId } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
      if (party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the party owner can reset media.' });
      if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Published Party media is immutable.' });
      await db.party.update({ where: { id: party.id }, data: { coverImageUrl: null, photoUrls: [] } });
      return { status: 'ready' as const };
    }),
  upload: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:media:upload' }))
    .input(partyMediaUploadInput)
    .mutation(async ({ ctx, input }) => {
      const party = await db.party.findUnique({ where: { id: input.partyId } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
      if (party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the party owner can upload media.' });
      if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Published Party media cannot be replaced here.' });
      if (input.kind === 'album' && input.index > party.photoUrls.length) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Album photos must be uploaded in order.' });
      }
      const slot = input.kind === 'cover' ? 'cover' : `album-${input.index}`;
      const url = await uploadPartyImage(input.dataUri, `bytspot/parties/${party.id}/${slot}`);
      if (input.kind === 'cover') {
        await db.party.update({ where: { id: party.id }, data: { coverImageUrl: url } });
      } else {
        const photoUrls = [...party.photoUrls];
        photoUrls[input.index] = url;
        await db.party.update({ where: { id: party.id }, data: { photoUrls } });
      }
      return { kind: input.kind, url, index: input.kind === 'album' ? input.index : null };
    }),
});

export const eventsRouter = router({
  drafts: partyDraftsRouter,
  media: partyMediaRouter,

  /** Premium-only, server-authoritative Advanced App Clip Experience queue. */
  discovery: router({
    capability: protectedProcedure.query(async ({ ctx }) => {
      const tier = await viewerPartyTier(ctx.user.userId);
      return {
        tier,
        advancedExperienceAllowed: canProvisionAppleDiscovery(tier),
        workerConfigured: config.appleAdvancedAppClipProvisioningEnabled,
        fallback: 'standard-party-pass' as const,
      };
    }),

    status: protectedProcedure
      .input(z.object({ partyId: z.string().min(1).max(200) }))
      .query(async ({ ctx, input }) => {
        const party = await db.party.findUnique({ where: { id: input.partyId }, select: { id: true, hostId: true } });
        if (!party || party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
        const tier = await viewerPartyTier(ctx.user.userId);
        const shareUrl = `https://bytspot.app/party/${encodeURIComponent(party.id)}`;
        const job = await (db as any).partyAppleDiscoveryJob.findUnique({ where: { partyId: party.id } });
        return {
          tier,
          advancedExperienceAllowed: canProvisionAppleDiscovery(tier),
          workerConfigured: config.appleAdvancedAppClipProvisioningEnabled,
          job: job ? appleDiscoveryJobResponse(job, shareUrl) : null,
          fallback: { mode: 'standard-party-pass' as const, shareUrl },
        };
      }),

    request: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 6, label: 'events:discovery:request' }))
      .input(partyAppleDiscoveryInput)
      .mutation(async ({ ctx, input }) => {
        const [party, tier, venue] = await Promise.all([
          db.party.findUnique({ where: { id: input.partyId } }),
          viewerPartyTier(ctx.user.userId),
          db.venue.findUnique({ where: { id: input.venueId }, select: { id: true, name: true, lat: true, lng: true } }),
        ]);
        if (!party || party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
        if (party.status !== 'published') throw new TRPCError({ code: 'CONFLICT', message: 'Publish the Party Pass before requesting Apple Discovery.' });
        if (!canProvisionAppleDiscovery(tier)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Apple Discovery is available to Platinum and Black hosts.' });
        if (!venue || normalizedVenueName(venue.name) !== normalizedVenueName(party.venueName)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select the verified venue that matches this Party Pass.' });
        }
        if (partyLocationForPublicInvite(party).locationDisclosure !== 'public') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Hidden Party locations cannot be submitted to Apple Discovery.' });
        }

        const request = {
          version: 1,
          invocationUrl: `https://bytspot.app/party/${encodeURIComponent(party.id)}`,
          card: input.card,
          venue: { id: venue.id, name: venue.name, latitude: venue.lat, longitude: venue.lng },
          coverImageUrl: party.coverImageUrl ?? null,
        };
        const requestFingerprint = appleDiscoveryFingerprint(request);
        const status = config.appleAdvancedAppClipProvisioningEnabled ? 'queued' : 'configuration_required';
        const job = await (db as any).partyAppleDiscoveryJob.upsert({
          where: { partyId: party.id },
          create: {
            partyId: party.id,
            requestedByUserId: ctx.user.userId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint,
            hostTier: tier,
            status,
            request,
            failureCode: status === 'configuration_required' ? 'apple_discovery_worker_unconfigured' : null,
          },
          update: {},
        });
        if (job.requestFingerprint !== requestFingerprint || job.idempotencyKey !== input.idempotencyKey) {
          throw new TRPCError({ code: 'CONFLICT', message: 'This Party already has a different Apple Discovery request.' });
        }
        return appleDiscoveryJobResponse(job, request.invocationUrl);
      }),

    retry: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 3, label: 'events:discovery:retry' }))
      .input(z.object({ partyId: z.string().min(1).max(200), idempotencyKey }))
      .mutation(async ({ ctx, input }) => {
        const party = await db.party.findUnique({ where: { id: input.partyId }, select: { id: true, hostId: true } });
        if (!party || party.hostId !== ctx.user.userId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
        const tier = await viewerPartyTier(ctx.user.userId);
        if (!canProvisionAppleDiscovery(tier)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Apple Discovery is available to Platinum and Black hosts.' });
        const job = await (db as any).partyAppleDiscoveryJob.findUnique({ where: { partyId: party.id } });
        if (!job || job.idempotencyKey !== input.idempotencyKey) throw new TRPCError({ code: 'NOT_FOUND', message: 'Apple Discovery request not found.' });
        if (!['configuration_required', 'failed'].includes(job.status)) throw new TRPCError({ code: 'CONFLICT', message: 'This Apple Discovery request cannot be retried.' });
        const status = config.appleAdvancedAppClipProvisioningEnabled ? 'queued' : 'configuration_required';
        const updated = await (db as any).partyAppleDiscoveryJob.update({
          where: { id: job.id },
          data: { status, failureCode: status === 'configuration_required' ? 'apple_discovery_worker_unconfigured' : null, queuedAt: new Date() },
        });
        return appleDiscoveryJobResponse(updated, `https://bytspot.app/party/${encodeURIComponent(party.id)}`);
      }),
  }),

  /** Public invite details for an unguessable, published Party Pass URL. */
  invite: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 120, label: 'events:invite' }))
    .input(z.object({ partyId: z.string().min(1).max(200) }))
    .query(async ({ input }) => {
      const party = await db.party.findUnique({
        where: { id: input.partyId },
        include: { host: { select: { name: true } } },
      });
      if (!party || party.status !== 'published') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Party invite not found.' });
      }
      if (!hasValidCashDoorAmount(party)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Party invite not found.' });
      }
      // Legacy GroupEventGuest rows are not Party participation. Party-specific
      // guest state is introduced only through Party Pass actions.
      const participantCount = 0;
      const highlights = itineraryTitles(party.itinerary);
      const location = partyLocationForPublicInvite(party);
      const template = publicPartyTemplate(party);
      const ticketTiers = publicPartyTicketTiers(party);
      const creatorLinks = publicPartyCreatorLinks(party.creatorLinks);
      return {
        id: party.id,
        source: 'host-studio-party' as const,
        title: party.title,
        inviteNote: party.tagline || null,
        tier: party.requiredMembershipTier,
        timing: partyTiming(party.startsAt),
        participantCount,
        capacity: party.capacity,
        accessMode: party.accessMode,
        cashDoorPriceCents: party.accessMode === 'cash-at-door' ? party.cashDoorPriceCents : null,
        ticketTiers,
        creatorLinks,
        templateId: template.templateId,
        templateConfig: template.templateConfig,
        groupType: templateLabels[party.templateId] ?? 'Private Party',
        scheduledDate: party.startsAt.toISOString(),
        hostName: party.host.name ?? 'Bytspot Host',
        locationLabel: location.locationLabel,
        locationDisclosure: location.locationDisclosure,
        theme: party.tagline || (templateLabels[party.templateId] ?? 'Private Party'),
        guestSummary: participantCount === 0 ? `Be first to join · ${party.capacity} spots` : `${participantCount} joined · ${party.capacity} spots`,
        activityHighlights: highlights,
        audienceCircle: party.audienceCircleIds.length > 0 ? 'Selected Circles' : 'Shared Party Pass',
        privacyStatus: party.audienceCircleIds.length > 0 || party.accessMode === 'private-approval' ? 'privateInvite' : 'publicDiscovery',
        requiresApproval: party.accessMode === 'private-approval',
        heroImageURL: party.coverImageUrl,
        thumbnailURL: party.coverImageUrl,
        photoURLs: party.photoUrls,
      };
    }),

  /** Resolve a stable Living Party Pass touchpoint. Unknown or unconfigured states fail closed. */
  pass: router({
    resolve: publicProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'events:pass:resolve' }))
      .input(z.object({ touchpointRef: z.string().min(16).max(200).optional(), partyId: z.string().min(1).max(200).optional() }).refine((input) => Boolean(input.touchpointRef || input.partyId), 'A Party Pass reference is required.'))
      .query(async ({ ctx, input }) => {
        if (input.touchpointRef) {
          const touchpoint = await db.partyTouchpoint.findUnique({ where: { reference: input.touchpointRef }, include: { party: true } });
          return resolvePartyPass(touchpoint?.party, touchpoint, ctx.user?.userId);
        }
        const party = await db.party.findUnique({ where: { id: input.partyId! }, include: { touchpoints: { where: { kind: 'digital' } } } });
        return resolvePartyPass(party, party?.touchpoints?.[0], ctx.user?.userId);
      }),
  }),

  /** Server-authorized RSVP or approval request. Party IDs never touch legacy guest rows. */
  rsvp: router({
    create: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'events:rsvp:create' }))
      .input(z.object({ partyId: z.string().min(1).max(200), idempotencyKey }))
      .mutation(async ({ ctx, input }) => db.$transaction(async (tx) => {
        const party = await tx.party.findUnique({ where: { id: input.partyId }, include: { touchpoints: { where: { kind: 'digital' } } } });
        if (!party || party.status !== 'published') throw new TRPCError({ code: 'NOT_FOUND', message: 'Party Pass not found.' });
        if (!hasValidCashDoorAmount(party)) throw new TRPCError({ code: 'CONFLICT', message: 'Cash-at-door pricing is unavailable for this Party.' });
        const tier = await viewerPartyTier(ctx.user.userId);
        if (!partyTierAllows(tier, party.requiredMembershipTier)) throw new TRPCError({ code: 'FORBIDDEN', message: `${party.requiredMembershipTier === 'black' ? 'Black' : 'Platinum'} membership required.` });
        if (partyLifecycle(party.startsAt) !== 'before') throw new TRPCError({ code: 'CONFLICT', message: 'This Party is no longer accepting RSVP requests.' });
        if (party.accessMode === 'paid-ticket') throw new TRPCError({ code: 'CONFLICT', message: 'A verified ticket checkout is required for this Party.' });
        if (party.accessMode === 'open-entry') throw new TRPCError({ code: 'CONFLICT', message: 'This Party does not require a reservation.' });
        const current = await (tx as any).partyParticipation.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
        if (!current) {
          const accepted = party.accessMode === 'private-approval' ? 'pending' : 'rsvp';
          if (accepted === 'rsvp') {
            const count = await (tx as any).partyParticipation.count({ where: { partyId: party.id, status: { in: ['rsvp', 'approved', 'checked_in'] } } });
            if (count >= party.capacity) throw new TRPCError({ code: 'CONFLICT', message: 'This Party is at capacity.' });
          }
          await (tx as any).partyParticipation.upsert({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } }, create: { partyId: party.id, userId: ctx.user.userId, status: accepted }, update: {} });
        }
        const refreshed = await (tx as any).partyParticipation.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } }, select: { status: true, checkedInAt: true } });
        const action = actionForPartyViewer({ party, viewerTier: tier, participation: refreshed, isAuthenticated: true });
        return { partyId: party.id, status: refreshed?.status ?? 'rsvp', action, accessGranted: action === 'view-pass' };
      })),
  }),

  tickets: router({
    createCheckout: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 8, label: 'events:tickets:createCheckout' }))
      .input(z.object({ partyId: z.string().min(1).max(200), ticketTierName: z.string().min(1).max(80), idempotencyKey }))
      .mutation(async ({ ctx, input }) => {
        if (!config.stripeSecretKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payments are not configured.' });
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
        const prepared = await db.$transaction(async (tx) => {
          const party = await tx.party.findUnique({ where: { id: input.partyId } });
          if (!party || party.status !== 'published' || party.accessMode !== 'paid-ticket') throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticketed Party not found.' });
          const viewerTier = await viewerPartyTier(ctx.user.userId);
          const participation = await (tx as any).partyParticipation.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } }, select: { status: true } });
          if (actionForPartyViewer({ party, viewerTier, participation, isAuthenticated: true }) !== 'ticket') throw new TRPCError({ code: 'FORBIDDEN', message: 'Ticket checkout is not available for this Party.' });
          const tier = paidTicketTier(party, input.ticketTierName);
          if (!partyTierAllows(viewerTier, tier.requiredMembershipTier)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Membership tier does not permit this ticket.' });
          const orders = (tx as any).partyTicketOrder;
          const existing = await orders.findUnique({ where: { partyId_userId: { partyId: party.id, userId: ctx.user.userId } } });
          if (existing?.status === 'paid') throw new TRPCError({ code: 'CONFLICT', message: 'You already have a paid ticket for this Party.' });
          if (existing) {
            const pending = await (tx as any).checkoutAttempt.findFirst({ where: { partyTicketOrderId: existing.id, reconciliationState: 'pending' }, orderBy: { createdAt: 'desc' } });
            if (pending) throw new TRPCError({ code: 'CONFLICT', message: 'Your previous checkout must be reconciled by Stripe before you can retry.' });
          }
          const active = { reconciliationState: { in: ['pending', 'fulfilled'] } };
          const [partyReserved, tierReserved] = await Promise.all([
            (tx as any).checkoutAttempt.count({ where: { partyId: party.id, ...active } }),
            (tx as any).checkoutAttempt.count({ where: { partyId: party.id, ticketTierName: tier.name, ...active } }),
          ]);
          if (partyReserved >= party.capacity || tierReserved >= tier.quantity) throw new TRPCError({ code: 'CONFLICT', message: 'This ticket tier is sold out.' });
          const data = { ticketTierName: tier.name, amountCents: tier.priceCents, currency: 'usd', status: 'pending_checkout', idempotencyKey: input.idempotencyKey, stripeSessionId: null, stripePaymentIntentId: null, checkoutExpiresAt: null, paidAt: null };
          const order = existing
            ? await orders.update({ where: { id: existing.id }, data })
            : await orders.create({ data: { partyId: party.id, userId: ctx.user.userId, ...data } });
          const attempt = await (tx as any).checkoutAttempt.create({ data: { partyTicketOrderId: order.id, partyId: party.id, userId: ctx.user.userId, ticketTierName: tier.name, amountCents: tier.priceCents, currency: 'usd', checkoutExpiresAt: expiresAt } });
          return { party, tier, order, attempt, expiresAt };
        }, { isolationLevel: 'Serializable' });
        const { party, tier, attempt } = prepared;
        const stripe = new Stripe(config.stripeSecretKey);
        let stripeSessionCreated = false;
        try {
          const session = await stripe.checkout.sessions.create({
            mode: 'payment', payment_method_types: ['card'],
            line_items: [{ price_data: { currency: 'usd', unit_amount: tier.priceCents, product_data: { name: `${party.title} — ${tier.name}` } }, quantity: 1 }],
            metadata: { flow: 'party.ticket', partyId: party.id, orderId: attempt.partyTicketOrderId, checkoutAttemptId: attempt.id, userId: ctx.user.userId },
            payment_intent_data: { metadata: { flow: 'party.ticket', partyId: party.id, orderId: attempt.partyTicketOrderId, checkoutAttemptId: attempt.id, userId: ctx.user.userId } },
            expires_at: Math.floor(prepared.expiresAt.getTime() / 1000),
            success_url: `${config.frontendUrl}/party/${encodeURIComponent(party.id)}?checkout=success`, cancel_url: `${config.frontendUrl}/party/${encodeURIComponent(party.id)}?checkout=cancelled`,
          }, { idempotencyKey: `party-ticket:${attempt.id}` });
          if (!session.url || !session.id) throw new Error('Stripe omitted the checkout session URL or ID.');
          stripeSessionCreated = true;
          await (db as any).checkoutAttempt.update({ where: { id: attempt.id }, data: { stripeSessionId: session.id } });
          return { orderId: attempt.partyTicketOrderId, checkoutAttemptId: attempt.id, url: session.url, status: 'pending_checkout' as const };
        } catch (error) {
          if (!stripeSessionCreated) {
            await (db as any).checkoutAttempt.updateMany({ where: { id: attempt.id, reconciliationState: 'pending', stripeSessionId: null }, data: { reconciliationState: 'failed', reconciledAt: new Date(), failureCode: 'session_creation_failed' } });
          }
          throw error;
        }
      }),
    webhook: stripeWebhookProcedure
      .input(z.object({ type: z.string(), data: z.object({ object: z.any() }) }))
      .mutation(async ({ input }) => {
        const session = input.data.object as { id?: string; status?: string; payment_intent?: string | { id?: string }; payment_status?: string; metadata?: Record<string, string> };
        if (!session.id || session.metadata?.flow !== 'party.ticket') return { ignored: true };
        const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        const state = (input.type === 'checkout.session.completed' || input.type === 'checkout.session.async_payment_succeeded') && session.payment_status === 'paid' ? 'fulfilled'
          : input.type === 'checkout.session.expired' && session.status === 'expired' && session.payment_status !== 'paid' ? 'expired'
            : input.type === 'checkout.session.async_payment_failed' ? 'failed' : null;
        if (!state) return { ignored: true };
        await db.$transaction(async (tx) => {
          const transitioned = await (tx as any).checkoutAttempt.updateMany({ where: { stripeSessionId: session.id, reconciliationState: 'pending' }, data: { reconciliationState: state, stripePaymentIntentId: state === 'fulfilled' ? paymentIntent ?? null : undefined, reconciledAt: new Date(), failureCode: state === 'failed' ? 'async_payment_failed' : null } });
          if (transitioned.count !== 1) return;
          if (state !== 'fulfilled') return;
          const attempt = await (tx as any).checkoutAttempt.findUnique({ where: { stripeSessionId: session.id } });
          if (!attempt) return;
          const order = await (tx as any).partyTicketOrder.findUnique({ where: { id: attempt.partyTicketOrderId } });
          if (!order) return;
          await (tx as any).partyTicketOrder.updateMany({ where: { id: order.id, status: 'pending_checkout' }, data: { status: 'paid', stripePaymentIntentId: paymentIntent ?? null, paidAt: new Date() } });
          const participation = await (tx as any).partyParticipation.findUnique({ where: { partyId_userId: { partyId: order.partyId, userId: order.userId } }, select: { status: true } });
          if (!participation) await (tx as any).partyParticipation.create({ data: { partyId: order.partyId, userId: order.userId, status: 'rsvp' } });
        });
        return { reconciled: state };
      }),
  }),

  /** Publish is an owner capability. Replays return the original Party Pass. */
  publish: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'events:publish' }))
    .input(z.object({ partyId: z.string().min(1).max(200), idempotencyKey }))
    .mutation(async ({ ctx, input }) => db.$transaction(async (tx) => {
      const party = await tx.party.findUnique({ where: { id: input.partyId } });
      if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party not found.' });
      if (party.hostId !== ctx.user.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the party owner can publish this draft.' });
      }
      if (party.idempotencyKey !== input.idempotencyKey) {
        throw new TRPCError({ code: 'CONFLICT', message: 'The publish key does not match this party draft.' });
      }
      if (party.status !== 'draft') {
        if (party.status !== 'published') {
          throw new TRPCError({ code: 'CONFLICT', message: 'Only draft parties can be published.' });
        }
      }

      let published = party;
      if (party.status === 'draft') {
        await tx.party.updateMany({
          where: { id: party.id, hostId: ctx.user.userId, idempotencyKey: input.idempotencyKey, status: 'draft' },
          data: { status: 'published', passCode: partyPassCode(), publishedAt: new Date() },
        });
        const reloaded = await tx.party.findUnique({ where: { id: party.id } });
        if (!reloaded) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Published party could not be loaded.' });
        published = reloaded;
      }
      await tx.partyTouchpoint.upsert({
        where: { partyId_kind: { partyId: published.id, kind: 'digital' } },
        create: {
          partyId: published.id,
          reference: partyTouchpointReference(published.id),
          kind: 'digital',
          lifecyclePolicy: defaultPartyPassPolicy(published.accessMode),
        },
        update: {},
      });
      return publishedParty(published);
    })),

  /** List events near Atlanta (cached 15 min) */
  list: publicProcedure
    .input(z.object({
      category: z.string().optional(),
      limit: z.number().min(1).max(50).optional().default(20),
    }).optional().default({}))
    .query(async ({ input }) => {
      const { category, limit } = input;

      if (!config.ticketmasterApiKey) {
        return { events: [], source: 'unavailable' as const };
      }

      const cacheKey = `events:atl:${category ?? 'all'}:${limit}`;
      const events = await cached(cacheKey, 900, async () => {
        const params = new URLSearchParams({
          apikey: config.ticketmasterApiKey,
          city: 'Atlanta',
          stateCode: 'GA',
          size: String(limit),
          sort: 'date,asc',
        });
        if (category) {
          const segmentMap: Record<string, string> = {
            concert: 'Music', comedy: 'Arts & Theatre', art: 'Arts & Theatre',
            sports: 'Sports', food: 'Miscellaneous',
          };
          if (segmentMap[category]) params.set('segmentName', segmentMap[category]);
        }

        const res = await fetch(`${TM_BASE}/events.json?${params}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
          console.error(`[events] Ticketmaster ${res.status}: ${await res.text().catch(() => '')}`);
          return [];
        }
        const data = (await res.json()) as { _embedded?: { events?: TmEvent[] } };
        const raw: TmEvent[] = data._embedded?.events ?? [];
        return raw.map(mapTmEvent);
      });

      return { events: events ?? [], source: 'ticketmaster' as const };
    }),
});

