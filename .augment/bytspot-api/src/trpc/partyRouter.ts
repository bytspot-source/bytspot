import { randomBytes } from 'crypto';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';

const maxMediaBytes = 600_000;
const maxAlbumImages = 6;
const partyKinds = ['listening-party', 'comedy-night', 'premiere', 'private-party', 'fan-meetup', 'release-party', 'pop-up'] as const;
const accessModes = ['free-rsvp', 'paid-ticket', 'private-approval'] as const;
const tiers = ['green', 'platinum'] as const;
const hostRoles = ['cohost', 'door', 'finance'] as const;

const draftInput = z.object({
  idempotencyKey: z.string().uuid(),
  templateId: z.enum(partyKinds),
  title: z.string().trim().min(3).max(140),
  tagline: z.string().trim().max(280),
  startsAt: z.string().datetime({ offset: true }),
  venueName: z.string().trim().min(1).max(200),
  capacity: z.number().int().min(2).max(10_000),
  accessMode: z.enum(accessModes),
  requiredMembershipTier: z.enum(tiers),
  audienceCircleIds: z.array(z.string().min(1).max(128)).max(100),
  itinerary: z.array(z.object({ title: z.string().trim().min(1).max(160), offsetMinutes: z.number().int().min(0).max(10_080) })).max(30),
  ticketTiers: z.array(z.object({ name: z.string().trim().min(1).max(100), priceCents: z.number().int().min(0).max(10_000_000), quantity: z.number().int().min(1).max(10_000), requiredMembershipTier: z.enum(tiers) })).max(10),
  cohosts: z.array(z.object({ email: z.string().email().max(255), role: z.enum(hostRoles) })).max(20),
  templateConfig: z.object({ kind: z.enum(partyKinds) }).passthrough(),
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
  if (input.templateConfig.kind !== input.templateId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateConfig', 'kind'], message: 'Template configuration must match the Party template.' });
  }
  if (input.templateId === 'private-party' && input.accessMode !== 'private-approval') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accessMode'], message: 'Private Parties require approval access.' });
  }
  const hasPaidTier = input.ticketTiers.some((tier) => tier.priceCents > 0);
  if (input.accessMode === 'paid-ticket' && !hasPaidTier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Paid Parties need a paid ticket tier.' });
  }
  if (input.accessMode !== 'paid-ticket' && hasPaidTier) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ticketTiers'], message: 'Only paid Parties can include paid ticket tiers.' });
  }
});

const mediaInput = z.object({
  partyId: z.string().min(1),
  kind: z.enum(['cover', 'album']),
  index: z.number().int().min(0).max(maxAlbumImages - 1).optional(),
  dataUri: z.string().max(900_000),
}).superRefine((input, ctx) => {
  if (input.kind === 'album' && input.index === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['index'], message: 'Album images require an index.' });
  }
  if (input.kind === 'cover' && input.index !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['index'], message: 'Cover images cannot specify an index.' });
  }
});

function partyShareUrl(id: string): string {
  return `${config.partyShareBaseUrl}/party/${encodeURIComponent(id)}`;
}

function partyMediaUrl(id: string): string {
  return `${config.publicApiUrl}/media/parties/${encodeURIComponent(id)}`;
}

function parseImageDataUri(dataUri: string): { bytes: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUri);
  if (!match) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Party media must be a JPEG, PNG, or WebP data URI.' });
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxMediaBytes || bytes.toString('base64') !== match[2]) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Party media must be a valid image no larger than 600 KB.' });
  }
  return { bytes, mimeType: match[1] };
}

async function ownedDraft(partyId: string, userId: string) {
  const party = await db.party.findFirst({ where: { id: partyId, hostUserId: userId } });
  if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
  if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Published Parties cannot be changed.' });
  return party;
}

function newPassCode(): string {
  return `BYT-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}

export const partyDraftsRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-draft-create' }))
    .input(draftInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await db.party.findUnique({ where: { hostUserId_idempotencyKey: { hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
      if (existing) return { id: existing.id };
      try {
        const party = await db.party.create({
          data: {
            hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey, templateId: input.templateId,
            title: input.title, tagline: input.tagline, startsAt: new Date(input.startsAt), venueName: input.venueName,
            capacity: input.capacity, accessMode: input.accessMode, requiredMembershipTier: input.requiredMembershipTier,
            audienceCircleIds: input.audienceCircleIds, itinerary: input.itinerary, ticketTiers: input.ticketTiers,
            cohosts: input.cohosts, templateConfig: input.templateConfig as Prisma.InputJsonValue,
          },
        });
        return { id: party.id };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const concurrent = await db.party.findUnique({ where: { hostUserId_idempotencyKey: { hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
        if (concurrent) return { id: concurrent.id };
        throw error;
      }
    }),
});

export const partyMediaRouter = router({
  reset: protectedProcedure
    .input(z.object({ partyId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ownedDraft(input.partyId, ctx.user.userId);
      await db.partyMedia.deleteMany({ where: { partyId: input.partyId } });
      return { status: 'ready' as const };
    }),
  upload: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'party-media-upload' }))
    .input(mediaInput)
    .mutation(async ({ ctx, input }) => {
      await ownedDraft(input.partyId, ctx.user.userId);
      const { bytes, mimeType } = parseImageDataUri(input.dataUri);
      const imageBytes = Uint8Array.from(bytes);
      const position = input.kind === 'cover' ? 0 : input.index!;
      const media = await db.partyMedia.upsert({
        where: { partyId_kind_position: { partyId: input.partyId, kind: input.kind, position } },
        create: { partyId: input.partyId, kind: input.kind, position, mimeType, bytes: imageBytes, byteSize: imageBytes.length },
        update: { mimeType, bytes: imageBytes, byteSize: imageBytes.length },
      });
      return { url: partyMediaUrl(media.id) };
    }),
});

export const partyPublish = protectedProcedure
  .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-publish' }))
  .input(z.object({ partyId: z.string().min(1), idempotencyKey: z.string().uuid() }))
  .mutation(async ({ ctx, input }) => {
    const party = await db.party.findFirst({ where: { id: input.partyId, hostUserId: ctx.user.userId } });
    if (!party) throw new TRPCError({ code: 'NOT_FOUND', message: 'Party draft not found.' });
    if (party.idempotencyKey !== input.idempotencyKey) throw new TRPCError({ code: 'CONFLICT', message: 'The publish request does not match this Party draft.' });
    if (party.status === 'published' && party.passCode) return { id: party.id, shareUrl: partyShareUrl(party.id), passCode: party.passCode };
    if (party.status !== 'draft') throw new TRPCError({ code: 'CONFLICT', message: 'Party cannot be published from its current state.' });
    const result = { id: party.id, shareUrl: partyShareUrl(party.id), passCode: newPassCode() };
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get(`idem:party-publish:${ctx.user.userId}:${input.idempotencyKey}`).catch(() => null);
      if (cached) return JSON.parse(cached) as typeof result;
    }
    const published = await db.party.updateMany({
      where: { id: party.id, hostUserId: ctx.user.userId, status: 'draft' },
      data: { status: 'published', passCode: result.passCode, publishedAt: new Date() },
    });
    if (published.count !== 1) {
      const concurrent = await db.party.findFirst({ where: { id: party.id, hostUserId: ctx.user.userId } });
      if (concurrent?.status === 'published' && concurrent.passCode) {
        return { id: concurrent.id, shareUrl: partyShareUrl(concurrent.id), passCode: concurrent.passCode };
      }
      throw new TRPCError({ code: 'CONFLICT', message: 'Party could not be published. Please retry.' });
    }
    if (redis) redis.set(`idem:party-publish:${ctx.user.userId}:${input.idempotencyKey}`, JSON.stringify(result), 'EX', 86_400).catch(() => {});
    return result;
  });