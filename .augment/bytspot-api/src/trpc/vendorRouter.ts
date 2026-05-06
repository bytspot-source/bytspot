import { Entity, type Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import Stripe from 'stripe';
import { randomBytes } from 'crypto';
import { config } from '../config';
import { db } from '../lib/db';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router, sovereignShieldMiddleware } from './trpc';
import { assertVendorRole, claimRoleForVendor, normalizeProviderRole, type ProviderRole, vendorGroups } from '../auth/vendorRbac';
import { type AuthPayload } from '../middleware/auth';

const vendorFrameworks = ['NIST_AI_RMF_1_0', 'EO_14365'] as const;
const OWNER_ONLY = ['owner'] as const;
const OPS_WRITE = ['owner', 'manager'] as const;
const MEMBER_READ = ['owner', 'manager', 'staff'] as const;

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
  createdAt: true,
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

const vendorBookingSelect = {
  id: true,
  serviceId: true,
  vendorId: true,
  userId: true,
  status: true,
  priceCents: true,
  platformFeeCents: true,
  currency: true,
  scheduledFor: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  service: {
    select: {
      id: true,
      title: true,
      priceCents: true,
      currency: true,
      durationMins: true,
      patch: { select: patchSelect },
    },
  },
  user: { select: { id: true, name: true, email: true } },
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
  createdAt: Date;
  updatedAt: Date;
};

type VendorPatchDashboardService = {
  id: string;
  title: string;
  status?: string;
  patchId?: string | null;
  patch?: VendorPatchRow | null;
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
    status: patch.status,
    binding: patch.bindingType && patch.bindingId ? { type: patch.bindingType, id: patch.bindingId } : null,
    confirmedAt: patch.confirmedAt?.toISOString() ?? null,
    createdAt: patch.createdAt.toISOString(),
    updatedAt: patch.updatedAt.toISOString(),
  };
}

function buildProviderPatchUrl(patchId: string, vendorName: string, serviceId?: string | null): string {
  const root = config.frontendUrl.replace(/\/$/, '');
  const encodedVenue = encodeURIComponent(vendorName.trim() || 'Bytspot Provider');
  const base = `${root}/p/${encodeURIComponent(patchId)}?patch=${encodeURIComponent(patchId)}&venue=${encodedVenue}`;
  return serviceId ? `${base}&service=${encodeURIComponent(serviceId)}` : base;
}

function mapVendorPatchRecord(
  patch: VendorPatchRow,
  vendor: VendorRow,
  service?: VendorPatchDashboardService | null,
) {
  const serviceId = service?.id ?? (patch.bindingType === 'service' ? patch.bindingId : null);
  return {
    ...mapPatchSummary(patch),
    label: patch.label ?? 'Provider Patch',
    venueName: vendor.displayName,
    serviceId,
    serviceTitle: service?.title ?? null,
    url: buildProviderPatchUrl(patch.id, vendor.displayName, serviceId),
  };
}

function createVirtualPatchUid(): string {
  return randomBytes(7).toString('hex').toUpperCase();
}

function mapVendorService(service: VendorServiceRow, includeCashFlow = true) {
  const platformFeeCents = Math.round(service.priceCents * (service.vendor.commissionBps / 10_000));
  const row: Record<string, unknown> = {
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
  };
  if (includeCashFlow) {
    row.cashFlow = {
      grossCents: service.priceCents,
      platformFeeCents,
      providerPayoutEstimateCents: service.priceCents - platformFeeCents,
      commissionBps: service.vendor.commissionBps,
    };
  }
  return row;
}

function mapVendorBooking(booking: any, vendor: VendorRow, includeCashFlow = true) {
  const startsAt = booking.scheduledFor ?? booking.createdAt;
  const endsAt = booking.completedAt ?? (startsAt && booking.service?.durationMins
    ? new Date(startsAt.getTime() + booking.service.durationMins * 60_000)
    : null);
  const grossCents = Number(booking.priceCents ?? booking.service?.priceCents ?? 0);
  const platformFeeCents = Number(booking.platformFeeCents ?? Math.round(grossCents * (vendor.commissionBps / 10_000)));
  const row: Record<string, unknown> = {
    id: booking.id,
    serviceId: booking.serviceId,
    vendorId: booking.vendorId,
    status: booking.status,
    startsAt: startsAt?.toISOString?.() ?? null,
    endsAt: endsAt?.toISOString?.() ?? null,
    scheduledFor: booking.scheduledFor?.toISOString?.() ?? null,
    completedAt: booking.completedAt?.toISOString?.() ?? null,
    priceCents: grossCents,
    currency: booking.currency ?? booking.service?.currency ?? 'USD',
    guest: {
      id: booking.user?.id ?? booking.userId,
      displayName: booking.user?.name ?? booking.user?.email ?? 'Guest',
    },
    service: {
      id: booking.service?.id ?? booking.serviceId,
      title: booking.service?.title ?? 'Booking',
      priceCents: booking.service?.priceCents ?? grossCents,
      currency: booking.service?.currency ?? booking.currency ?? 'USD',
      durationMins: booking.service?.durationMins ?? null,
      patch: isBoundServicePatch(booking.service?.patch ?? null, booking.service?.id ?? booking.serviceId)
        ? mapPatchSummary(booking.service.patch)
        : null,
    },
    patch: isBoundServicePatch(booking.service?.patch ?? null, booking.service?.id ?? booking.serviceId)
      ? mapPatchSummary(booking.service.patch)
      : null,
    createdAt: booking.createdAt?.toISOString?.() ?? null,
    updatedAt: booking.updatedAt?.toISOString?.() ?? null,
  };
  if (includeCashFlow) {
    row.cashFlow = {
      grossCents,
      platformFeeCents,
      providerPayoutEstimateCents: Math.max(0, grossCents - platformFeeCents),
      commissionBps: vendor.commissionBps,
    };
  }
  return row;
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

function mapVendorOnboarding(vendor: VendorRow, role: ProviderRole = 'owner') {
  return {
    id: vendor.id,
    entity: vendor.entity,
    displayName: vendor.displayName,
    legalName: vendor.legalName,
    stripeAccountId: vendor.stripeAccountId,
    onboardingStatus: vendor.onboardingStatus,
    commissionBps: vendor.commissionBps,
    providerRole: role,
    groups: vendorGroups(vendor.id, role),
    updatedAt: vendor.updatedAt.toISOString(),
  };
}

type VendorAccess = { vendor: VendorRow; role: ProviderRole };

function lowerRole(left: ProviderRole, right: ProviderRole): ProviderRole {
  const rank: Record<ProviderRole, number> = { staff: 1, manager: 2, owner: 3 };
  return rank[left] <= rank[right] ? left : right;
}

async function roleForVendor(user: AuthPayload, vendor: VendorRow): Promise<ProviderRole | null> {
  let dbRole: ProviderRole | null = vendor.userId === user.userId ? 'owner' : null;
  if (!dbRole) {
    const membership = await (db as any).vendorMember?.findUnique?.({
      where: { vendorId_userId: { vendorId: vendor.id, userId: user.userId } },
      select: { role: true },
    });
    dbRole = membership ? normalizeProviderRole(membership.role) : null;
  }
  if (!dbRole) return null;
  const claimRole = claimRoleForVendor(user, vendor.id);
  return claimRole ? lowerRole(dbRole, claimRole) : dbRole;
}

async function resolveVendorAccess(
  user: AuthPayload,
  vendorId: string | undefined,
  allowed: readonly ProviderRole[],
  operation: string,
): Promise<VendorAccess | null> {
  if (vendorId) {
    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: vendorSelect });
    if (!vendor) return null;
    const role = await roleForVendor(user, vendor as VendorRow);
    if (!role) throw new TRPCError({ code: 'FORBIDDEN', message: 'Vendor profile does not belong to this user' });
    assertVendorRole(role, allowed, operation);
    return { vendor: vendor as VendorRow, role };
  }

  const owned = await db.vendor.findFirst({ where: { userId: user.userId }, orderBy: { updatedAt: 'desc' }, select: vendorSelect }) as VendorRow | null;
  if (owned) {
    assertVendorRole('owner', allowed, operation);
    return { vendor: owned, role: 'owner' };
  }

  const membership = await (db as any).vendorMember?.findFirst?.({
    where: { userId: user.userId },
    orderBy: { updatedAt: 'desc' },
    select: { role: true, vendor: { select: vendorSelect } },
  });
  if (!membership?.vendor) return null;
  const dbRole = normalizeProviderRole(membership.role);
  const claimRole = claimRoleForVendor(user, membership.vendor.id);
  const role = claimRole ? lowerRole(dbRole, claimRole) : dbRole;
  assertVendorRole(role, allowed, operation);
  return { vendor: membership.vendor as VendorRow, role };
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
      let existingAccess: VendorAccess | null = null;
      if (input.vendorId) {
        existingAccess = await resolveVendorAccess(ctx.user, input.vendorId, OWNER_ONLY, 'Stripe Connect onboarding');
      } else {
        const ownedVendor = await db.vendor.findFirst({ where: { userId }, orderBy: { updatedAt: 'desc' }, select: vendorSelect }) as VendorRow | null;
        if (ownedVendor) existingAccess = { vendor: ownedVendor, role: 'owner' };
      }
      let vendor = existingAccess?.vendor ?? null;
      let providerRole: ProviderRole = existingAccess?.role ?? 'owner';
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
        await (db as any).vendorMember?.upsert?.({
          where: { vendorId_userId: { vendorId: vendor.id, userId } },
          create: { vendorId: vendor.id, userId, role: 'OWNER' },
          update: { role: 'OWNER' },
        });
        providerRole = 'owner';
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
        vendor: mapVendorOnboarding(vendor, providerRole),
        providerRole,
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
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'Vendor session sync');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      if (!config.stripeSecretKey) {
        return { demoMode: true, message: 'Stripe not configured', vendor: mapVendorOnboarding(vendor, providerRole), providerRole };
      }
      if (!vendor.stripeAccountId) {
        return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, account: null };
      }
      if (providerRole !== 'owner') {
        return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, account: null };
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const account = await stripe.accounts.retrieve(vendor.stripeAccountId);
      const updated = await updateVendorFromAccount(vendor, account);
      return {
        vendor: mapVendorOnboarding(updated, providerRole),
        providerRole,
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
      return { received: true, vendor: mapVendorOnboarding(updated, 'owner') };
    }),

  listServices: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:listServices' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_SERVICE_MANAGEMENT_READ'],
        policyContext: { surface: 'vendors', operation: 'listServices' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        status: z.enum(['active', 'draft', 'archived', 'all']).optional().default('all'),
        limit: z.number().int().min(1).max(100).optional().default(50),
      }).optional().default({}),
    )
    .query(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'List vendor services');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      const where: Prisma.VendorServiceWhereInput = { vendorId: vendor.id };
      if (input.status !== 'all') where.status = input.status;

      const services = await db.vendorService.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: serviceSelect,
      });

      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, services: services.map((service) => mapVendorService(service, providerRole === 'owner')) };
    }),

  createService: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'vendors:createService' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_SERVICE_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'createService' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        title: z.string().trim().min(2).max(120),
        description: z.string().trim().max(600).nullable().optional(),
        priceCents: z.number().int().min(50).max(1_000_000),
        currency: z.string().trim().length(3).optional().default('USD'),
        durationMins: z.number().int().min(5).max(24 * 60).nullable().optional(),
        status: z.enum(['active', 'draft']).optional().default('active'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, OPS_WRITE, 'Create vendor services');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;

      const service = await db.vendorService.create({
        data: {
          vendorId: vendor.id,
          title: input.title,
          description: input.description ?? null,
          priceCents: input.priceCents,
          currency: input.currency.toUpperCase(),
          durationMins: input.durationMins ?? null,
          status: input.status,
        },
        select: serviceSelect,
      });

      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, service: mapVendorService(service as VendorServiceRow, providerRole === 'owner') };
    }),

  listBookings: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:listBookings' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_READ'],
        policyContext: { surface: 'vendors', operation: 'listBookings' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        status: z.enum(['pending', 'paid', 'confirmed', 'completed', 'canceled', 'refunded', 'disputed', 'all']).optional().default('all'),
        limit: z.number().int().min(1).max(100).optional().default(50),
      }).optional().default({}),
    )
    .query(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'List vendor bookings');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      const where: Prisma.BookingWhereInput = { vendorId: vendor.id };
      if (input.status !== 'all') where.status = input.status;

      const bookings = await db.booking.findMany({
        where,
        orderBy: [{ scheduledFor: 'desc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: vendorBookingSelect,
      });

      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, bookings: bookings.map((booking) => mapVendorBooking(booking, vendor, providerRole === 'owner')) };
    }),

  updateService: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:updateService' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_SERVICE_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'updateService' },
      }),
    )
    .input(
      z.object({
        serviceId: z.string().min(1).max(120),
        title: z.string().trim().min(2).max(120).optional(),
        description: z.string().trim().max(600).nullable().optional(),
        priceCents: z.number().int().min(50).max(1_000_000).optional(),
        durationMins: z.number().int().min(5).max(24 * 60).nullable().optional(),
        status: z.enum(['active', 'draft', 'archived']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await db.vendorService.findUnique({ where: { id: input.serviceId }, select: serviceSelect });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor service not found' });
      const access = await resolveVendorAccess(ctx.user, existing.vendorId, OPS_WRITE, 'Update vendor services');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });

      const data: Prisma.VendorServiceUpdateInput = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.priceCents !== undefined) data.priceCents = input.priceCents;
      if (input.durationMins !== undefined) data.durationMins = input.durationMins;
      if (input.status !== undefined) data.status = input.status;

      const service = await db.vendorService.update({
        where: { id: input.serviceId },
        data,
        select: serviceSelect,
      });

      return { providerRole: access.role, service: mapVendorService(service, access.role === 'owner') };
    }),

  listPatches: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:listPatches' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_PATCH_MANAGEMENT_READ'],
        policyContext: { surface: 'vendors', operation: 'listPatches' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        limit: z.number().int().min(1).max(100).optional().default(50),
      }).optional().default({}),
    )
    .query(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'List vendor patches');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;

      const services = await db.vendorService.findMany({
        where: { vendorId: vendor.id },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: { id: true, title: true, status: true, patchId: true, patch: { select: patchSelect } },
      }) as VendorPatchDashboardService[];

      const servicePatchRecords = services
        .filter((service) => service.patch && isBoundServicePatch(service.patch, service.id))
        .map((service) => mapVendorPatchRecord(service.patch!, vendor, service));

      const vendorPatches = await db.hardwarePatch.findMany({
        where: { bindingType: 'vendor', bindingId: vendor.id, entity: Entity.VENDOR_SERVICES },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: patchSelect,
      }) as VendorPatchRow[];

      const recordsById = new Map<string, ReturnType<typeof mapVendorPatchRecord>>();
      for (const record of [...servicePatchRecords, ...vendorPatches.map((patch) => mapVendorPatchRecord(patch, vendor, null))]) {
        recordsById.set(record.id, record);
      }

      const patches = Array.from(recordsById.values())
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, input.limit);

      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, patches };
    }),

  createPatch: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:createPatch' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_PATCH_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'createPatch' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        label: z.string().trim().min(1).max(120),
        serviceId: z.string().min(1).max(120).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, OPS_WRITE, 'Create vendor patches');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;

      let service: VendorPatchDashboardService | null = null;
      if (input.serviceId) {
        const row = await db.vendorService.findUnique({
          where: { id: input.serviceId },
          select: { id: true, vendorId: true, title: true, status: true, patchId: true },
        }) as (VendorPatchDashboardService & { vendorId: string }) | null;
        if (!row || row.vendorId !== vendor.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor service not found' });
        }
        if (row.patchId) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Service already has a patch bound' });
        }
        service = row;
      }

      const bindingType = service ? 'service' : 'vendor';
      const bindingId = service?.id ?? vendor.id;
      let patch: VendorPatchRow | null = null;
      for (let attempt = 0; attempt < 3 && !patch; attempt += 1) {
        try {
          patch = await db.hardwarePatch.create({
            data: {
              uid: createVirtualPatchUid(),
              label: input.label,
              tagType: 'BYTSPOT_LINK',
              entity: Entity.VENDOR_SERVICES,
              status: 'bound',
              bindingType,
              bindingId,
              confirmedAt: new Date(),
            },
            select: patchSelect,
          }) as VendorPatchRow;
        } catch (error: any) {
          if (error?.code !== 'P2002' || attempt === 2) throw error;
        }
      }
      if (!patch) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unable to create patch' });

      if (service) {
        await db.vendorService.update({ where: { id: service.id }, data: { patchId: patch.id } });
      }

      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, patch: mapVendorPatchRecord(patch, vendor, service) };
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

      return { services: services.map((service) => mapVendorService(service)) };
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