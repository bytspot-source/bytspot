import { TRPCError } from '@trpc/server';
import { Entity } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { getActiveICTKid, signICT, verifyICT } from '../services/ictSigner';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router, sovereignShieldMiddleware } from './trpc';

const bindingTypeSchema = z.enum(['vendor', 'service', 'venue']);
const uidHexSchema = z.string().min(1, 'UID is required');

function normalizePatchUid(uid: string): string {
  const normalized = uid.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!/^[0-9A-F]{14}$/.test(normalized)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'UID must be a 7-byte hex string' });
  }
  return normalized;
}

function mapPatch(
  patch: {
    id: string;
    uid: string;
    tagType: string;
    sdmKeyRef: string | null;
    readCounter: number;
    label: string | null;
    status: string;
    entity: Entity;
    bindingType: string | null;
    bindingId: string | null;
    confirmedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
) {
  return {
    id: patch.id,
    uid: patch.uid,
    tagType: patch.tagType,
    sdmKeyRef: patch.sdmKeyRef,
    readCounter: patch.readCounter,
    label: patch.label,
    status: patch.status,
    entity: patch.entity,
    binding: patch.bindingType && patch.bindingId ? { type: patch.bindingType, id: patch.bindingId } : null,
    confirmedAt: patch.confirmedAt?.toISOString() ?? null,
    createdAt: patch.createdAt.toISOString(),
    updatedAt: patch.updatedAt.toISOString(),
  };
}

async function getBindingEntity(bindingType: z.infer<typeof bindingTypeSchema>, bindingId: string) {
  switch (bindingType) {
    case 'vendor': {
      const vendor = await db.vendor.findUnique({ where: { id: bindingId }, select: { id: true } });
      if (!vendor) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor not found' });
      return Entity.VENDOR_SERVICES;
    }
    case 'service': {
      const service = await db.vendorService.findUnique({
        where: { id: bindingId },
        select: { id: true, patchId: true },
      });
      if (!service) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor service not found' });
      return { entity: Entity.VENDOR_SERVICES, service };
    }
    case 'venue': {
      const venue = await db.venue.findUnique({ where: { id: bindingId }, select: { id: true } });
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' });
      return Entity.EXPERIENCES;
    }
  }
}

function getICTErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Invalid ICT token';
}

const patchFrameworks = ['NIST_AI_RMF_1_0', 'EO_14365'] as const;

/**
 * ── Revocations sub-router (NIST RS.MI-1) ───────────────
 * Source of truth for the client-side revocation cache populated by the
 * `useRevocationList` hook in bytspot-beta. `list` returns the active
 * revocation set scoped by vendor (or platform-wide when vendorId is null).
 */
const revocationsRouter = router({
  list: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'patch:revocations:list' }))
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).nullable().optional(),
        since: z.string().datetime({ offset: true }).optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      const vendorId = input?.vendorId ?? null;
      const since = input?.since ? new Date(input.since) : null;

      // Active revocations = platform-wide rows (vendorId null) UNION
      // vendor-scoped rows for the requested tenant. The client merges them
      // into a single in-memory Set, so duplicates are harmless.
      const where =
        vendorId === null
          ? { vendorId: null }
          : { OR: [{ vendorId: null }, { vendorId }] };

      const rows = await db.revokedPatch.findMany({
        where: since ? { ...where, createdAt: { gt: since } } : where,
        select: { patchId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });

      const revokedIds = Array.from(new Set(rows.map((r) => r.patchId)));
      return {
        revokedIds,
        fetchedAt: new Date().toISOString(),
        delta: Boolean(since),
      };
    }),
});

export const patchRouter = router({
  revocations: revocationsRouter,

  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'patch:create' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.BYTSPOT_INC,
        frameworks: patchFrameworks,
        stateFlags: ['PATCH_PROVISIONING'],
        policyContext: { surface: 'patch', operation: 'create' },
      }),
    )
    .input(
      z.object({
        uid: uidHexSchema,
        label: z.string().trim().min(1).max(120).optional(),
        tagType: z.string().trim().min(1).max(40).optional(),
        sdmKeyRef: z.string().trim().min(1).max(255).optional(),
        entity: z.nativeEnum(Entity).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const uid = normalizePatchUid(input.uid);

      try {
        const patch = await db.hardwarePatch.create({
          data: {
            uid,
            label: input.label,
            tagType: input.tagType ?? 'NTAG424_DNA',
            sdmKeyRef: input.sdmKeyRef,
            entity: input.entity ?? Entity.BYTSPOT_INC,
            status: 'unbound',
          },
        });
        return mapPatch(patch);
      } catch (error: any) {
        if (error?.code === 'P2002') {
          throw new TRPCError({ code: 'CONFLICT', message: 'A patch with that UID already exists' });
        }
        throw error;
      }
    }),

  confirmBinding: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'patch:confirmBinding' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.BYTSPOT_INC,
        frameworks: patchFrameworks,
        stateFlags: ['PATCH_BINDING'],
        policyContext: { surface: 'patch', operation: 'confirmBinding' },
      }),
    )
    .input(
      z.object({
        patchId: z.string().min(1),
        bindingType: bindingTypeSchema,
        bindingId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const patch = await db.hardwarePatch.findUnique({ where: { id: input.patchId } });
      if (!patch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Hardware patch not found' });
      if (patch.status === 'retired') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Retired patches cannot be rebound' });
      }
      if (
        patch.bindingType &&
        patch.bindingId &&
        (patch.bindingType !== input.bindingType || patch.bindingId !== input.bindingId)
      ) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Patch is already bound to another target' });
      }

      const resolved = await getBindingEntity(input.bindingType, input.bindingId);
      let entity: Entity;
      if (resolved === Entity.VENDOR_SERVICES || resolved === Entity.EXPERIENCES) {
        entity = resolved;
      } else {
        entity = resolved.entity;
        if (resolved.service.patchId && resolved.service.patchId !== patch.id) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Service already has a different patch bound' });
        }
        await db.vendorService.update({ where: { id: input.bindingId }, data: { patchId: patch.id } });
      }

      const updatedPatch = await db.hardwarePatch.update({
        where: { id: patch.id },
        data: {
          bindingType: input.bindingType,
          bindingId: input.bindingId,
          status: 'bound',
          entity,
          confirmedAt: new Date(),
        },
      });

      return mapPatch(updatedPatch);
    }),

  rotatingToken: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'patch:rotatingToken' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.BYTSPOT_INC,
        frameworks: patchFrameworks,
        stateFlags: ['PATCH_TOKEN_ROTATION'],
        policyContext: { surface: 'patch', operation: 'rotatingToken' },
      }),
    )
    .input(
      z.object({
        patchId: z.string().min(1),
        ttlSec: z.number().int().min(30).max(600).optional().default(120),
        geo: z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().optional() }).optional(),
        device: z.object({ fingerprint: z.string().min(1).optional(), platform: z.string().min(1).optional() }).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const patch = await db.hardwarePatch.findUnique({ where: { id: input.patchId } });
      if (!patch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Hardware patch not found' });
      if (patch.status === 'retired') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Retired patches cannot issue verification tokens' });
      }

      const token = signICT(
        {
          sub: ctx.user?.userId,
          action: 'patch.tap',
          resource: { type: 'patch', id: patch.id },
          geo: input.geo,
          device: input.device,
          uid: patch.uid,
          entity: patch.entity,
          bindingType: patch.bindingType,
          bindingId: patch.bindingId,
          readCounter: patch.readCounter,
        },
        { ttlSec: input.ttlSec },
      );

      return {
        token,
        kid: getActiveICTKid(),
        expiresInSec: input.ttlSec,
        patch: mapPatch(patch),
      };
    }),

  verifyTap: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'patch:verifyTap' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.BYTSPOT_INC,
        frameworks: patchFrameworks,
        stateFlags: ['PATCH_TAP_VERIFICATION'],
        policyContext: { surface: 'patch', operation: 'verifyTap' },
      }),
    )
    .input(
      z.object({
        token: z.string().min(1),
        uid: uidHexSchema.optional(),
        readCounter: z.number().int().nonnegative().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      let claims;
      try {
        claims = verifyICT(input.token);
      } catch (error) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: getICTErrorMessage(error) });
      }

      if (claims.action !== 'patch.tap' || claims.resource.type !== 'patch') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'ICT token is not a patch tap token' });
      }

      const patch = await db.hardwarePatch.findUnique({ where: { id: claims.resource.id } });
      if (!patch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Hardware patch not found' });
      if (patch.status === 'retired') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Retired patches cannot be verified' });
      }

      const claimedUid = typeof claims.uid === 'string' ? normalizePatchUid(claims.uid) : undefined;
      const suppliedUid = input.uid ? normalizePatchUid(input.uid) : undefined;
      if (claimedUid && claimedUid !== patch.uid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'ICT token UID does not match the patch' });
      }
      if (suppliedUid && suppliedUid !== patch.uid) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Supplied UID does not match the patch' });
      }

      let verifiedPatch = patch;
      if (typeof input.readCounter === 'number') {
        if (input.readCounter <= patch.readCounter) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Tap counter is stale or has already been used' });
        }
        verifiedPatch = await db.hardwarePatch.update({
          where: { id: patch.id },
          data: { readCounter: input.readCounter },
        });
      }

      return {
        verified: true,
        patch: mapPatch(verifiedPatch),
        binding: verifiedPatch.bindingType && verifiedPatch.bindingId
          ? { type: verifiedPatch.bindingType, id: verifiedPatch.bindingId }
          : null,
        token: {
          jti: claims.jti,
          action: claims.action,
          subject: claims.sub ?? null,
          issuedAt: new Date(claims.iat * 1000).toISOString(),
          expiresAt: new Date(claims.exp * 1000).toISOString(),
        },
      };
    }),
});