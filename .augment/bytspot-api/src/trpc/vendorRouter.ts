import { Entity, type Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import Stripe from 'stripe';
import { randomBytes } from 'crypto';
import { config } from '../config';
import { db } from '../lib/db';
import { createVendorExpirationWarnings, createVendorNotification, expireVendorOpenRequests, getVendorUnreadNotificationCount } from '../services/vendorNotifications';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router, sovereignShieldMiddleware, stripeWebhookProcedure } from './trpc';
import { assertVendorRole, claimRoleForVendor, normalizeProviderRole, type ProviderRole, vendorGroups } from '../auth/vendorRbac';
import { type AuthPayload } from '../middleware/auth';

const vendorFrameworks = ['NIST_AI_RMF_1_0', 'EO_14365'] as const;
const OWNER_ONLY = ['owner'] as const;
const OPS_WRITE = ['owner', 'manager'] as const;
const MEMBER_READ = ['owner', 'manager', 'staff'] as const;

const serviceTierSchema = z.enum(['SIMPLE', 'GREEN', 'PLATINUM', 'BLACK']);
const requestStatusSchema = z.enum(['REQUESTED', 'HOLD_AUTHORIZED', 'ACCEPTED', 'DECLINED', 'COUNTER_OFFERED', 'EXPIRED', 'CANCELLED', 'COMPLETED']);
const incomingRequestStatuses = ['REQUESTED', 'HOLD_AUTHORIZED', 'COUNTER_OFFERED'] as const;
const activeBookingStatuses = ['paid', 'confirmed', 'funds_authorized', 'in_progress'] as const;
const lifecycleStatusSchema = z.enum(['confirmed', 'in_progress', 'completed', 'cancelled']);

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
  category: true,
  priceCents: true,
  currency: true,
  durationMins: true,
  maxGuests: true,
  patchRequired: true,
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

const vendorBookingSelect: any = {
  id: true,
  serviceId: true,
  vendorId: true,
  userId: true,
  status: true,
  priceCents: true,
  platformFeeCents: true,
  currency: true,
  tier: true,
  requestStatus: true,
  requestExpiresAt: true,
  acceptedAt: true,
  declinedAt: true,
  counterOfferCents: true,
  counterOfferCurrency: true,
  counterOfferMessage: true,
  guestNotes: true,
  logisticsMode: true,
  stripePaymentIntentId: true,
  stripeTransferDestination: true,
  metadata: true,
  scheduledFor: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  service: {
    select: {
      id: true,
      title: true,
      category: true,
      priceCents: true,
      currency: true,
      durationMins: true,
      tier: true,
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
  category: string;
  priceCents: number;
  currency: string;
  durationMins: number | null;
  maxGuests: number | null;
  patchRequired: boolean;
  tier?: string | null;
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
    category: service.category,
    priceCents: service.priceCents,
    currency: service.currency,
    durationMins: service.durationMins,
    maxGuests: service.maxGuests,
    patchRequired: service.patchRequired,
    tier: service.tier ?? 'SIMPLE',
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
    tier: booking.tier ?? booking.service?.tier ?? 'SIMPLE',
    requestStatus: booking.requestStatus ?? null,
    request: {
      status: booking.requestStatus ?? null,
      expiresAt: booking.requestExpiresAt?.toISOString?.() ?? null,
      acceptedAt: booking.acceptedAt?.toISOString?.() ?? null,
      declinedAt: booking.declinedAt?.toISOString?.() ?? null,
      counterOfferCents: booking.counterOfferCents ?? null,
      counterOfferCurrency: booking.counterOfferCurrency ?? null,
      counterOfferMessage: booking.counterOfferMessage ?? null,
      guestNotes: booking.guestNotes ?? null,
      logisticsMode: booking.logisticsMode ?? null,
    },
    payment: {
      status: booking.metadata?.secureHoldStatus ?? booking.metadata?.paymentIntentStatus ?? null,
      captureMode: booking.metadata?.captureMode ?? null,
    },
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

function mapVendorNotification(notification: any) {
  return {
    id: notification.id,
    vendorId: notification.vendorId,
    bookingId: notification.bookingId ?? null,
    recipientUserId: notification.recipientUserId ?? null,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    payload: notification.payload ?? null,
    readAt: notification.readAt?.toISOString?.() ?? null,
    createdAt: notification.createdAt?.toISOString?.() ?? null,
    updatedAt: notification.updatedAt?.toISOString?.() ?? null,
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

function secureHoldIsAuthorized(booking: any, metadata: Record<string, unknown>): boolean {
  return Boolean(booking.stripePaymentIntentId)
    && (booking.status === 'funds_authorized'
      || (metadata.captureMode === 'manual' && metadata.secureHoldStatus === 'funds_authorized'));
}

async function updateVendorBookingStatus(user: AuthPayload, bookingId: string, status: 'confirmed' | 'in_progress' | 'completed' | 'cancelled') {
  const existing = await db.booking.findUnique({ where: { id: bookingId }, select: vendorBookingSelect as any }) as any;
  if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });
  const access = await resolveVendorAccess(user, existing.vendorId, MEMBER_READ, 'Update booking handoff');
  if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });
  const { vendor, role: providerRole } = access;
  const existingMetadata = metadataObject(existing.metadata ?? null);
  const shouldCaptureSecureHold = status === 'completed' && secureHoldIsAuthorized(existing, existingMetadata);

  let capturedPaymentIntent: Stripe.PaymentIntent | null = null;
  if (shouldCaptureSecureHold) {
    assertVendorRole(providerRole, OPS_WRITE, 'Capture secure hold');
    if (!config.stripeSecretKey) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payments are not configured.' });
    }
    const stripe = new Stripe(config.stripeSecretKey);
    capturedPaymentIntent = await stripe.paymentIntents.capture(existing.stripePaymentIntentId!, {
      amount_to_capture: existing.priceCents,
      metadata: {
        ...Object.fromEntries(Object.entries(existingMetadata).map(([key, value]) => [key, String(value ?? '')])),
        secureHoldStatus: 'captured_after_completion',
        capturedByUserId: user.userId,
        capturedByVendorId: vendor.id,
        capturedVia: 'vendors.updateBookingStatus',
      },
    });
  }

  const bookingUpdateData: any = {
    status,
    completedAt: status === 'completed' ? new Date() : existing.completedAt,
  };
  if (status === 'completed') bookingUpdateData.requestStatus = 'COMPLETED';
  if (status === 'cancelled') bookingUpdateData.requestStatus = 'CANCELLED';
  if (status === 'confirmed' || status === 'in_progress') bookingUpdateData.requestStatus = 'ACCEPTED';
  if (shouldCaptureSecureHold) {
    bookingUpdateData.metadata = {
      ...existingMetadata,
      secureHoldStatus: 'captured_after_completion',
      paymentIntentStatus: capturedPaymentIntent?.status ?? 'succeeded',
      capturedAt: new Date().toISOString(),
      capturedByUserId: user.userId,
      capturedByVendorId: vendor.id,
    };
  }

  const booking = await db.booking.update({
    where: { id: existing.id },
    data: bookingUpdateData,
    select: vendorBookingSelect as any,
  }) as any;

  if (status === 'completed') {
    await createVendorNotification({
      vendorId: vendor.id,
      bookingId: booking.id,
      type: 'COMPLETED',
      title: 'Booking completed',
      body: `${booking.service?.title ?? 'Booking'} has been completed.`,
      payload: { bookingId: booking.id, tier: booking.tier ?? null, paymentCaptured: shouldCaptureSecureHold },
    });
  }

  return {
    vendor: mapVendorOnboarding(vendor, providerRole),
    providerRole,
    booking: mapVendorBooking(booking, vendor, providerRole === 'owner'),
    paymentCapture: shouldCaptureSecureHold
      ? {
          paymentIntentId: existing.stripePaymentIntentId,
          status: capturedPaymentIntent?.status ?? 'succeeded',
          amountCaptured: capturedPaymentIntent?.amount_received ?? existing.priceCents,
          message: 'Secure hold captured after service completion.',
        }
      : null,
  };
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
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payments are not configured.' });
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
        return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, account: null, stripeConfigured: false };
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

  connectWebhook: stripeWebhookProcedure
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
        category: z.string().trim().min(2).max(80).optional().default('General'),
        priceCents: z.number().int().min(1).max(1_000_000),
        currency: z.string().trim().length(3).optional().default('USD'),
        durationMins: z.number().int().min(15).max(24 * 60).nullable().optional(),
        maxGuests: z.number().int().min(1).max(500).nullable().optional(),
        patchRequired: z.boolean().optional().default(false),
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
          category: input.category,
          priceCents: input.priceCents,
          currency: input.currency.toUpperCase(),
          durationMins: input.durationMins ?? null,
          maxGuests: input.maxGuests ?? null,
          patchRequired: input.patchRequired,
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
        status: z.enum(['pending', 'paid', 'confirmed', 'funds_authorized', 'in_progress', 'completed', 'canceled', 'cancelled', 'refunded', 'disputed', 'all']).optional().default('all'),
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

  listIncomingRequests: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:listIncomingRequests' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_READ'],
        policyContext: { surface: 'vendors', operation: 'listIncomingRequests' },
      }),
    )
    .input(
      z.object({
        vendorId: z.string().min(1).max(120).optional(),
        status: requestStatusSchema.or(z.literal('all')).optional().default('all'),
        tier: serviceTierSchema.or(z.literal('all')).optional().default('all'),
        limit: z.number().int().min(1).max(100).optional().default(50),
      }).optional().default({}),
    )
    .query(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'List incoming requests');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      const expiredRequests = await expireVendorOpenRequests({ vendorId: vendor.id });
      const where: any = { vendorId: vendor.id };
      where.requestStatus = input.status === 'all' ? { in: [...incomingRequestStatuses] } : input.status;
      if (input.tier !== 'all') where.tier = input.tier;
      const bookings = await db.booking.findMany({
        where,
        orderBy: [{ requestExpiresAt: 'asc' }, { createdAt: 'desc' }] as any,
        take: input.limit,
        select: vendorBookingSelect as any,
      }) as any[];
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, expiredRequests, requests: bookings.map((booking) => mapVendorBooking(booking, vendor, providerRole === 'owner')) };
    }),

  listActiveBookings: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:listActiveBookings' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_READ'],
        policyContext: { surface: 'vendors', operation: 'listActiveBookings' },
      }),
    )
    .input(z.object({ vendorId: z.string().min(1).max(120).optional(), limit: z.number().int().min(1).max(100).optional().default(50) }).optional().default({}))
    .query(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'List active bookings');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      const bookings = await db.booking.findMany({
        where: { vendorId: vendor.id, status: { in: [...activeBookingStatuses] }, requestStatus: 'ACCEPTED' } as any,
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }] as any,
        take: input.limit,
        select: vendorBookingSelect as any,
      }) as any[];
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, bookings: bookings.map((booking) => mapVendorBooking(booking, vendor, providerRole === 'owner')) };
    }),

  getRequest: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 40, label: 'vendors:getRequest' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_READ'],
        policyContext: { surface: 'vendors', operation: 'getRequest' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      const booking = await db.booking.findUnique({ where: { id: input.bookingId }, select: vendorBookingSelect as any }) as any;
      if (!booking) throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found' });
      const access = await resolveVendorAccess(ctx.user, booking.vendorId, MEMBER_READ, 'Get request detail');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });
      const { vendor, role: providerRole } = access;
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, request: mapVendorBooking(booking, vendor, providerRole === 'owner') };
    }),

  acceptRequest: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:acceptRequest' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'acceptRequest' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.booking.findUnique({ where: { id: input.bookingId }, select: vendorBookingSelect as any }) as any;
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found' });
      const access = await resolveVendorAccess(ctx.user, existing.vendorId, OPS_WRITE, 'Accept request');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });
      const { vendor, role: providerRole } = access;
      if (existing.requestExpiresAt && existing.requestExpiresAt.getTime() < Date.now()) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This request has expired.' });
      }
      const bookingStatus = ['pending', 'paid', 'funds_authorized'].includes(existing.status) ? 'confirmed' : existing.status;
      const booking = await db.booking.update({
        where: { id: existing.id },
        data: {
          status: bookingStatus,
          requestStatus: 'ACCEPTED',
          acceptedAt: new Date(),
          metadata: { ...metadataObject(existing.metadata ?? null), acceptedByUserId: ctx.user.userId, acceptedAt: new Date().toISOString() },
        } as any,
        select: vendorBookingSelect as any,
      }) as any;
      await createVendorNotification({ vendorId: vendor.id, bookingId: booking.id, type: 'BOOKING_CONFIRMED', title: 'Request accepted', body: `${booking.service?.title ?? 'Request'} was accepted.`, payload: { bookingId: booking.id, tier: booking.tier ?? null } });
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, request: mapVendorBooking(booking, vendor, providerRole === 'owner') };
    }),

  declineRequest: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:declineRequest' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'declineRequest' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1).max(120), reason: z.string().trim().max(280).optional() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.booking.findUnique({ where: { id: input.bookingId }, select: vendorBookingSelect as any }) as any;
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found' });
      const access = await resolveVendorAccess(ctx.user, existing.vendorId, OPS_WRITE, 'Decline request');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });
      const { vendor, role: providerRole } = access;
      const existingMetadata = metadataObject(existing.metadata ?? null);
      let releasedPaymentIntent: Stripe.PaymentIntent | null = null;
      if (secureHoldIsAuthorized(existing, existingMetadata)) {
        if (!config.stripeSecretKey) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payments are not configured.' });
        const stripe = new Stripe(config.stripeSecretKey);
        releasedPaymentIntent = await (stripe.paymentIntents as any).cancel(existing.stripePaymentIntentId, { cancellation_reason: 'requested_by_customer' });
      }
      const booking = await db.booking.update({
        where: { id: existing.id },
        data: {
          status: 'canceled',
          requestStatus: 'DECLINED',
          declinedAt: new Date(),
          metadata: {
            ...existingMetadata,
            declinedByUserId: ctx.user.userId,
            declinedAt: new Date().toISOString(),
            declineReason: input.reason ?? null,
            secureHoldStatus: releasedPaymentIntent ? 'released_after_decline' : existingMetadata.secureHoldStatus,
            paymentIntentStatus: releasedPaymentIntent?.status ?? existingMetadata.paymentIntentStatus,
          },
        } as any,
        select: vendorBookingSelect as any,
      }) as any;
      await createVendorNotification({ vendorId: vendor.id, bookingId: booking.id, type: 'DECLINED', title: 'Request declined', body: `${booking.service?.title ?? 'Request'} was declined.`, payload: { bookingId: booking.id, reason: input.reason ?? null, tier: booking.tier ?? null } });
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, request: mapVendorBooking(booking, vendor, providerRole === 'owner'), paymentRelease: releasedPaymentIntent ? { paymentIntentId: releasedPaymentIntent.id, status: releasedPaymentIntent.status } : null };
    }),

  counterOffer: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:counterOffer' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'counterOffer' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1).max(120), amountCents: z.number().int().min(50).max(1_000_000), currency: z.string().trim().min(3).max(3).default('USD'), message: z.string().trim().min(1).max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.booking.findUnique({ where: { id: input.bookingId }, select: vendorBookingSelect as any }) as any;
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Request not found' });
      const access = await resolveVendorAccess(ctx.user, existing.vendorId, OPS_WRITE, 'Counter offer request');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });
      const { vendor, role: providerRole } = access;
      const booking = await db.booking.update({
        where: { id: existing.id },
        data: {
          requestStatus: 'COUNTER_OFFERED',
          counterOfferCents: input.amountCents,
          counterOfferCurrency: input.currency.toUpperCase(),
          counterOfferMessage: input.message ?? null,
          metadata: { ...metadataObject(existing.metadata ?? null), counterOfferByUserId: ctx.user.userId, counterOfferedAt: new Date().toISOString() },
        } as any,
        select: vendorBookingSelect as any,
      }) as any;
      await createVendorNotification({ vendorId: vendor.id, bookingId: booking.id, type: 'COUNTER_OFFER', title: 'Counter offer sent', body: `${booking.service?.title ?? 'Request'} has a counter offer.`, payload: { bookingId: booking.id, amountCents: input.amountCents, currency: input.currency.toUpperCase(), tier: booking.tier ?? null } });
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, request: mapVendorBooking(booking, vendor, providerRole === 'owner') };
    }),

  updateBookingStatus: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:updateBookingStatus' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'updateBookingStatus' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1).max(120), status: lifecycleStatusSchema }))
    .mutation(async ({ ctx, input }) => {
      return updateVendorBookingStatus(ctx.user, input.bookingId, input.status);
    }),

  completeBooking: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'vendors:completeBooking' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: vendorFrameworks,
        stateFlags: ['VENDOR_BOOKING_MANAGEMENT_WRITE'],
        policyContext: { surface: 'vendors', operation: 'completeBooking' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => updateVendorBookingStatus(ctx.user, input.bookingId, 'completed')),

  listNotifications: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 40, label: 'vendors:listNotifications' }))
    .input(z.object({ vendorId: z.string().min(1).max(120).optional(), unreadOnly: z.boolean().optional().default(false), limit: z.number().int().min(1).max(100).optional().default(50), type: z.string().trim().min(1).max(80).optional() }).optional().default({}))
    .query(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'List notifications');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      const where: any = { vendorId: vendor.id };
      if (input.unreadOnly) where.readAt = null;
      if (input.type) where.type = input.type;
      const [notifications, unreadCount] = await Promise.all([
        (db as any).vendorNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: input.limit }),
        getVendorUnreadNotificationCount(vendor.id, input.type),
      ]);
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, notifications: notifications.map(mapVendorNotification), unreadCount };
    }),

  syncNotifications: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'vendors:syncNotifications' }))
    .input(z.object({ vendorId: z.string().min(1).max(120).optional(), warningWindowMinutes: z.number().int().min(1).max(180).optional().default(15) }).optional().default({}))
    .mutation(async ({ ctx, input }) => {
      const access = await resolveVendorAccess(ctx.user, input.vendorId, MEMBER_READ, 'Sync notifications');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'No vendor profile found' });
      const { vendor, role: providerRole } = access;
      const expiredRequests = await expireVendorOpenRequests({ vendorId: vendor.id });
      const expirationWarnings = await createVendorExpirationWarnings({ vendorId: vendor.id, warningWindowMinutes: input.warningWindowMinutes, limit: 100 });
      const unreadCount = await getVendorUnreadNotificationCount(vendor.id);
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, expiredRequests, expirationWarnings: { checked: expirationWarnings.checked, warningsCreated: expirationWarnings.warningsCreated }, unreadCount };
    }),

  markNotificationRead: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'vendors:markNotificationRead' }))
    .input(z.object({ notificationId: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await (db as any).vendorNotification.findUnique({ where: { id: input.notificationId } });
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Notification not found' });
      const access = await resolveVendorAccess(ctx.user, existing.vendorId, MEMBER_READ, 'Mark notification read');
      if (!access) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor profile not found' });
      const { vendor, role: providerRole } = access;
      const notification = await (db as any).vendorNotification.update({ where: { id: existing.id }, data: { readAt: existing.readAt ?? new Date() } });
      return { vendor: mapVendorOnboarding(vendor, providerRole), providerRole, notification: mapVendorNotification(notification) };
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
        category: z.string().trim().min(2).max(80).optional(),
        priceCents: z.number().int().min(1).max(1_000_000).optional(),
        durationMins: z.number().int().min(15).max(24 * 60).nullable().optional(),
        maxGuests: z.number().int().min(1).max(500).nullable().optional(),
        patchRequired: z.boolean().optional(),
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
      if (input.category !== undefined) data.category = input.category;
      if (input.priceCents !== undefined) data.priceCents = input.priceCents;
      if (input.durationMins !== undefined) data.durationMins = input.durationMins;
      if (input.maxGuests !== undefined) data.maxGuests = input.maxGuests;
      if (input.patchRequired !== undefined) data.patchRequired = input.patchRequired;
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
        where: {
          entity: Entity.VENDOR_SERVICES,
          OR: [
            { bindingType: 'vendor', bindingId: vendor.id },
            { bindingType: 'service', bindingId: { in: services.map((service) => service.id) } },
          ],
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        take: input.limit,
        select: patchSelect,
      }) as VendorPatchRow[];

      const serviceById = new Map(services.map((service) => [service.id, service]));

      const recordsById = new Map<string, ReturnType<typeof mapVendorPatchRecord>>();
      for (const record of [...servicePatchRecords, ...vendorPatches.map((patch) => mapVendorPatchRecord(patch, vendor, patch.bindingType === 'service' && patch.bindingId ? serviceById.get(patch.bindingId) ?? null : null))]) {
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

      if (service && !service.patchId) {
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
      if (input.patchId) {
        const patch = await db.hardwarePatch.findUnique({ where: { id: input.patchId }, select: patchSelect });
        if (patch?.bindingType === 'service' && patch.bindingId) where.id = patch.bindingId;
        else where.patchId = input.patchId;
      }
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