import { Entity, type Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router, sovereignShieldMiddleware } from './trpc';

const vendorFrameworks = ['NIST_AI_RMF_1_0', 'EO_14365'] as const;

const connectReturnPath = '/provider/connect/return';
const connectRefreshPath = '/provider/connect/refresh';

const vendorSelect = {
  id: true,
  userId: true,
  entity: true,
  displayName: true,
  legalName: true,
  stripeAccountId: true,
  onboardingStatus: true,
  commissionBps: true,
  metadata: true,
  updatedAt: true,
} as const;

const patchSelect = {
  id: true,
  uid: true,
  tagType: true,
  label: true,
  readCounter: true,
  status: true,
  bindingType: true,
  bindingId: true,
  confirmedAt: true,
  updatedAt: true,
} as const;

const serviceSelect = {
  id: true,
  vendorId: true,
  title: true,
  description: true,
  priceCents: true,
  currency: true,
  durationMins: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  vendor: {
    select: {
      id: true,
      displayName: true,
      onboardingStatus: true,
      commissionBps: true,
    },
  },
  patch: { select: patchSelect },
} as const;

type VendorPatchRow = {
  id: string;
  uid: string;
  tagType: string;
  label: string | null;
  readCounter: number;
  status: string;
  bindingType: string | null;
  bindingId: string | null;
  confirmedAt: Date | null;
  updatedAt: Date;
};

type VendorServiceRow = {
  id: string;
  vendorId: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  durationMins: number | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  vendor: {
    id: string;
    displayName: string;
    onboardingStatus: string;
    commissionBps: number;
  };
  patch: VendorPatchRow | null;
};

type VendorRow = {
  id: string;
  userId: string;
  entity: Entity;
  displayName: string;
  legalName: string | null;
  stripeAccountId: string | null;
  onboardingStatus: string;
  commissionBps: number;
  metadata: Prisma.JsonValue | null;
  updatedAt: Date;
};

function normalizePatchUid(uid: string): string {
  const normalized = uid.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (!/^[0-9A-F]{14}$/.test(normalized)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'UID must be a 7-byte hex string' });
  }
  return normalized;
}

function isBoundServicePatch(patch: VendorPatchRow | null, serviceId: string): patch is VendorPatchRow {
  return !!patch && patch.status === 'bound' && patch.bindingType === 'service' && patch.bindingId === serviceId;
}

function mapPatchSummary(patch: VendorPatchRow) {
  return {
    id: patch.id,
    uid: patch.uid,
    tagType: patch.tagType,
    label: patch.label,
    readCounter: patch.readCounter,
    confirmedAt: patch.confirmedAt?.toISOString() ?? null,
    updatedAt: patch.updatedAt.toISOString(),
  };
}

function mapVendorService(service: VendorServiceRow) {
  const platformFeeCents = Math.round(service.priceCents * (service.vendor.commissionBps / 10_000));
  return {
    id: service.id,
    title: service.title,
    description: service.description,
    priceCents: service.priceCents,
    currency: service.currency,
    durationMins: service.durationMins,
    status: service.status,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
    vendor: {
      id: service.vendor.id,
      displayName: service.vendor.displayName,
      onboardingStatus: service.vendor.onboardingStatus,
    },
    patch: isBoundServicePatch(service.patch, service.id) ? mapPatchSummary(service.patch) : null,
    cashFlow: {
      grossCents: service.priceCents,
      platformFeeCents,
      providerPayoutEstimateCents: service.priceCents - platformFeeCents,
      commissionBps: service.vendor.commissionBps,
    },
  };
}

function safePath(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  if (!path.startsWith('/') || path.startsWith('//')) return fallback;
  return path;
}

function connectUrl(path: string): string {
  return `${config.frontendUrl}${path}`;
}

function metadataObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function onboardingStatusForAccount(account: Stripe.Account): string {
  const requirements = account.requirements;
  const disabledReason = requirements?.disabled_reason;
  if (disabledReason) return 'suspended';
  const currentlyDue = requirements?.currently_due ?? [];
  const pastDue = requirements?.past_due ?? [];
  if (account.charges_enabled && account.payouts_enabled && currentlyDue.length === 0 && pastDue.length === 0) {
    return 'active';
  }
  return 'pending';
}

function mapVendorOnboarding(vendor: VendorRow) {
  return {
    id: vendor.id,
    entity: vendor.entity,
    displayName: vendor.displayName,
    legalName: vendor.legalName,
    stripeAccountId: vendor.stripeAccountId,
    onboardingStatus: vendor.onboardingStatus,
    commissionBps: vendor.commissionBps,
    updatedAt: vendor.updatedAt.toISOString(),
  };
}

async function findOwnedVendor(userId: string, vendorId?: string): Promise<VendorRow | null> {
  if (vendorId) {
    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: vendorSelect });
    if (vendor && vendor.userId !== userId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Vendor profile does not belong to this user' });
    }
    return vendor as VendorRow | null;
  }
  return db.vendor.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' }, select: vendorSelect }) as Promise<VendorRow | null>;
}

async function updateVendorFromAccount(vendor: VendorRow, account: Stripe.Account): Promise<VendorRow> {
  const onboardingStatus = onboardingStatusForAccount(account);
  const metadata = metadataObject(vendor.metadata);
  const updated = await db.vendor.update({
    where: { id: vendor.id },
    data: {
      stripeAccountId: account.id,
      onboardingStatus,
      metadata: {
        ...metadata,
        stripeConnect: {
          accountId: account.id,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          disabledReason: account.requirements?.disabled_reason ?? null,
          currentlyDue: account.requirements?.currently_due ?? [],
          pastDue: account.requirements?.past_due ?? [],
          syncedAt: new Date().toISOString(),
        },
      } as Prisma.InputJsonValue,
    },
    select: vendorSelect,
  });
  return updated as VendorRow;
}

export const vendorRouter = router({
  startOnboarding: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 5, label: 'vendors:startOnboarding' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_CONNECT_ONBOARDING'],
        policyContext: { surface: 'vendors', operation: 'startOnboarding' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        displayName: z.string().trim().min(2).max(120).optional(),
        legalName: z.string().trim().min(2).max(160).optional(),
        refreshPath: z.string().max(240).optional(),
        returnPath: z.string().max(240).optional(),
      }).optional().default({}),
    )
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) {
        return { url: null as string | null, demoMode: true, message: 'Stripe not configured' };
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const userId = ctx.user.userId;
      let vendor = await findOwnedVendor(userId, input.vendorId);
      if (!vendor) {
        if (!input.displayName) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found. Provide displayName to create one.' });
        }
        vendor = await db.vendor.create({
          data: {
            userId,
            entity: Entity.VENDOR_SERVICES,
            displayName: input.displayName,
            legalName: input.legalName,
            onboardingStatus: 'pending',
          },
          select: vendorSelect,
        }) as VendorRow;
      }

      let accountId = vendor.stripeAccountId;
      if (!accountId) {
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email: ctx.user.email,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_profile: {
            name: vendor.legalName ?? vendor.displayName,
            product_description: 'Bytspot marketplace services',
            url: config.frontendUrl,
          },
          metadata: {
            userId,
            vendorId: vendor.id,
            entity: Entity.VENDOR_SERVICES,
            flow: 'vendor.connect.onboarding',
          },
        });
        vendor = await updateVendorFromAccount(vendor, account);
        accountId = account.id;
      }

      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: connectUrl(safePath(input.refreshPath, connectRefreshPath)),
        return_url: connectUrl(safePath(input.returnPath, connectReturnPath)),
        type: 'account_onboarding',
      });

      return {
        url: link.url,
        expiresAt: link.expires_at ? new Date(link.expires_at * 1000).toISOString() : null,
        vendor: mapVendorOnboarding(vendor),
      };
    }),

  syncOnboarding: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:syncOnboarding' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_CONNECT_SYNC'],
        policyContext: { surface: 'vendors', operation: 'syncOnboarding' },
      }),
    )
    .input(z.object({ vendorId: z.string().min(1).max(120).optional() }).optional().default({}))
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) {
        return { demoMode: true, message: 'Stripe not configured' };
      }
      const vendor = await findOwnedVendor(ctx.user.userId, input.vendorId);
      if (!vendor) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      if (!vendor.stripeAccountId) {
        return { vendor: mapVendorOnboarding(vendor), account: null };
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const account = await stripe.accounts.retrieve(vendor.stripeAccountId);
      const updated = await updateVendorFromAccount(vendor, account);
      return {
        vendor: mapVendorOnboarding(updated),
        account: {
          id: account.id,
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled,
          detailsSubmitted: account.details_submitted,
          disabledReason: account.requirements?.disabled_reason ?? null,
        },
      };
    }),

  connectWebhook: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 100, label: 'vendors:connectWebhook' }))
    .input(
      z.object({
        type: z.string().max(100),
        data: z.object({ object: z.object({ id: z.string().min(1).max(120) }).passthrough() }),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.type !== 'account.updated') return { received: true, ignored: true };
      const account = input.data.object as unknown as Stripe.Account;
      const vendor = await db.vendor.findUnique({ where: { stripeAccountId: account.id }, select: vendorSelect }) as VendorRow | null;
      if (!vendor) return { received: true, ignored: true };
      const updated = await updateVendorFromAccount(vendor, account);
      return { received: true, vendor: mapVendorOnboarding(updated) };
    }),

  search: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'vendors:search' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_DISCOVERY_READ'],
        policyContext: { surface: 'vendors', operation: 'search' },
      }),
    )
    .input(
      z.object({
        query: z.string().trim().min(1).max(120).optional(),
        vendorId: z.string().min(1).max(120).optional(),
        patchId: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }).optional().default({}),
    )
    .query(async ({ input }) => {
      const where: Prisma.VendorServiceWhereInput = { status: 'active' };
      if (input.vendorId) where.vendorId = input.vendorId;
      if (input.patchId) where.patchId = input.patchId;
      if (input.query) {
        where.OR = [
          { title: { contains: input.query, mode: 'insensitive' } },
          { description: { contains: input.query, mode: 'insensitive' } },
          { vendor: { is: { displayName: { contains: input.query, mode: 'insensitive' } } } },
        ];
      }

      const services = await db.vendorService.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: serviceSelect,
      });

      return { services: services.map(mapVendorService) };
    }),

  getByPatch: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'vendors:getByPatch' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_PATCH_RESOLVE'],
        policyContext: { surface: 'vendors', operation: 'getByPatch' },
      }),
    )
    .input(
      z.object({
        patchId: z.string().min(1).max(120).optional(),
        uid: z.string().min(1).max(64).optional(),
      }).refine((input) => Boolean(input.patchId || input.uid), { message: 'patchId or uid is required' }),
    )
    .query(async ({ input }) => {
      const patch = await db.hardwarePatch.findUnique({
        where: input.patchId ? { id: input.patchId } : { uid: normalizePatchUid(input.uid!) },
        select: patchSelect,
      });

      const serviceId = patch?.bindingId ?? null;
      if (!patch || !serviceId || !isBoundServicePatch(patch, serviceId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No active vendor service is bound to this patch' });
      }

      const service = await db.vendorService.findUnique({
        where: { id: serviceId },
        select: serviceSelect,
      });

      if (!service || service.status !== 'active') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No active vendor service is bound to this patch' });
      }

      return {
        patch: mapPatchSummary(patch),
        service: mapVendorService({ ...service, patch: service.patch ?? patch }),
      };
    }),
});