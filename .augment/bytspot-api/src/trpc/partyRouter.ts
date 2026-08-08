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
const templateConfigKinds = [...partyKinds, 'standard'] as const;
const accessModes = ['free-rsvp', 'paid-ticket', 'private-approval'] as const;
const tiers = ['green', 'platinum', 'black'] as const;
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
  templateConfig: z.object({ kind: z.enum(templateConfigKinds) }).passthrough(),
  source: z.literal('host-studio'),
}).superRefine((input, ctx) => {
  const allowsStandardConfig = input.templateId === 'comedy-night' || input.templateId === 'premiere';
  if (input.templateConfig.kind === 'standard' && !allowsStandardConfig) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templateConfig', 'kind'], message: 'Standard configuration is only valid for Comedy Night and Premiere Parties.' });
  } else if (input.templateConfig.kind !== 'standard' && input.templateConfig.kind !== input.templateId) {
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
  if (bytes.length === 0 || bytes.length > maxMediaBytes) {
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Party media must be no larger than 600 KB.' });
  }
  if (bytes.toString('base64') !== match[2] || !hasImageSignature(bytes, match[1])) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Party media bytes do not match the declared image type.' });
  }
  return { bytes, mimeType: match[1] };
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
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

type PartyContent = Pick<Prisma.PartyUncheckedCreateInput,
  'templateId' | 'title' | 'tagline' | 'startsAt' | 'venueName' | 'capacity' | 'accessMode' |
  'requiredMembershipTier' | 'audienceCircleIds' | 'itinerary' | 'ticketTiers' | 'cohosts' | 'templateConfig'>;

function partyContent(input: z.infer<typeof draftInput>): PartyContent {
  return {
    templateId: input.templateId, title: input.title, tagline: input.tagline, startsAt: new Date(input.startsAt), venueName: input.venueName,
    capacity: input.capacity, accessMode: input.accessMode, requiredMembershipTier: input.requiredMembershipTier,
    audienceCircleIds: input.audienceCircleIds, itinerary: input.itinerary, ticketTiers: input.ticketTiers,
    cohosts: input.cohosts, templateConfig: input.templateConfig as Prisma.InputJsonValue,
  };
}

export const partyDraftsRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'party-draft-create' }))
    .input(draftInput)
    .mutation(async ({ ctx, input }) => {
      const existing = await db.party.findUnique({ where: { hostUserId_idempotencyKey: { hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
      if (existing) {
        if (existing.status === 'draft') await db.party.update({ where: { id: existing.id }, data: partyContent(input) });
        return { id: existing.id };
      }
      try {
        const party = await db.party.create({
          data: {
            hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey,
            ...partyContent(input),
          },
        });
        return { id: party.id };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        const concurrent = await db.party.findUnique({ where: { hostUserId_idempotencyKey: { hostUserId: ctx.user.userId, idempotencyKey: input.idempotencyKey } } });
        if (concurrent) {
          if (concurrent.status === 'draft') await db.party.update({ where: { id: concurrent.id }, data: partyContent(input) });
          return { id: concurrent.id };
        }
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
    const shareUrl = partyShareUrl(party.id);
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get(`idem:party-publish:${ctx.user.userId}:${input.idempotencyKey}`).catch(() => null);
      if (cached) return JSON.parse(cached) as { id: string; shareUrl: string; passCode: string };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = { id: party.id, shareUrl, passCode: newPassCode() };
      try {
        const published = await db.party.updateMany({
          where: { id: party.id, hostUserId: ctx.user.userId, status: 'draft' },
          data: { status: 'published', passCode: result.passCode, publishedAt: new Date() },
        });
        if (published.count === 1) {
          if (redis) redis.set(`idem:party-publish:${ctx.user.userId}:${input.idempotencyKey}`, JSON.stringify(result), 'EX', 86_400).catch(() => {});
          return result;
        }
      } catch (error) {
        if (!isUniqueConstraint(error) || attempt === 2) throw error;
        continue;
      }
      const concurrent = await db.party.findFirst({ where: { id: party.id, hostUserId: ctx.user.userId } });
      if (concurrent?.status === 'published' && concurrent.passCode) {
        return { id: concurrent.id, shareUrl: partyShareUrl(concurrent.id), passCode: concurrent.passCode };
      }
      throw new TRPCError({ code: 'CONFLICT', message: 'Party could not be published. Please retry.' });
    }
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Party pass generation failed.' });
  });