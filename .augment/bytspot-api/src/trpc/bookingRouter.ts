import { randomUUID } from 'node:crypto';
import { Entity } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import Stripe from 'stripe';
import { config } from '../config';
import { db } from '../lib/db';
import { getActiveICTKid, signICT } from '../services/ictSigner';
import { notifyVendorNewRequest } from '../services/vendorNotifications';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router, sovereignShieldMiddleware } from './trpc';

const bookingFrameworks = ['NIST_AI_RMF_1_0', 'EO_14365'] as const;
const POINTS_PER_USD = 100;
const CENTS_PER_USD = 100;
const MARKETPLACE_MIN_UNIT_AMOUNT_CENTS = 50;
const MARKETPLACE_CREDIT_TYPE = 'MARKETPLACE_CREDIT';
const PROVIDER_REQUEST_TTL_MS = 30 * 60_000;

const bookingUserForCustomerSelect = {
  id: true,
  email: true,
  name: true,
  phone: true,
  stripeCustomerId: true,
  authProvider: true,
} as const;

const secureHoldGuestContactSchema = z.object({
  email: z.string().trim().email().max(255).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  postalCode: z.string().trim().min(2).max(20).optional(),
  country: z.string().trim().min(2).max(2).optional(),
}).optional();

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

const bookingSelect: any = {
  id: true,
  userId: true,
  entity: true,
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
  stripeSessionId: true,
  stripePaymentIntentId: true,
  stripeTransferDestination: true,
  ictJti: true,
  scheduledFor: true,
  completedAt: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  service: {
    select: {
      id: true,
      title: true,
      description: true,
      durationMins: true,
      status: true,
      patch: { select: patchSelect },
    },
  },
  vendor: {
    select: {
      id: true,
      displayName: true,
    },
  },
} as const;

type BookingPatchRow = {
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

type BookingRow = {
  id: string;
  userId: string;
  entity: Entity;
  status: string;
  priceCents: number;
  platformFeeCents: number;
  currency: string;
  tier: string;
  requestStatus: string;
  requestExpiresAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  counterOfferCents: number | null;
  counterOfferCurrency: string | null;
  counterOfferMessage: string | null;
  guestNotes: string | null;
  logisticsMode: string | null;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  stripeTransferDestination: string | null;
  ictJti: string | null;
  scheduledFor: Date | null;
  completedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  service: {
    id: string;
    title: string;
    description: string | null;
    durationMins: number | null;
    status: string;
    patch: BookingPatchRow | null;
  };
  vendor: {
    id: string;
    displayName: string;
  };
};

type BookingUserForCustomer = {
  id: string;
  email: string;
  name: string | null;
  phone?: string | null;
  stripeCustomerId: string | null;
  authProvider?: string | null;
};

type SecureHoldGuestContact = {
  email?: string;
  name?: string;
  phone?: string;
  postalCode?: string;
  country?: string;
};

function isBoundServicePatch(patch: BookingPatchRow | null, serviceId: string): patch is BookingPatchRow {
  return !!patch && patch.status === 'bound' && patch.bindingType === 'service' && patch.bindingId === serviceId;
}

function isPointDebit(type: string): boolean {
  return type === 'spend' || type === 'SUBSCRIPTION_CREDIT' || type === MARKETPLACE_CREDIT_TYPE;
}

function getAvailablePoints(txns: { type: string; amount: number }[]): number {
  const earned = txns.filter((txn) => !isPointDebit(txn.type)).reduce((sum, txn) => sum + Math.max(0, txn.amount), 0);
  const debited = txns.filter((txn) => isPointDebit(txn.type)).reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
  return Math.max(0, earned - debited);
}

function pointsToCents(points: number): number {
  return Math.floor((Math.max(0, points) * CENTS_PER_USD) / POINTS_PER_USD);
}

function centsToPoints(cents: number): number {
  return Math.ceil((Math.max(0, cents) * POINTS_PER_USD) / CENTS_PER_USD);
}

function buildMarketplaceOffer(basePriceCents: number, commissionBps: number, availablePoints: number, usePoints = false) {
  const maxPointsDiscountCents = Math.min(
    pointsToCents(availablePoints),
    Math.max(0, basePriceCents - MARKETPLACE_MIN_UNIT_AMOUNT_CENTS),
  );
  const pointsDiscountCents = usePoints ? maxPointsDiscountCents : 0;
  const finalChargeCents = Math.max(MARKETPLACE_MIN_UNIT_AMOUNT_CENTS, basePriceCents - pointsDiscountCents);
  const platformFeeCents = Math.round(finalChargeCents * (commissionBps / 10_000));
  return {
    basePriceCents,
    finalChargeCents,
    pointsDiscountCents,
    pointsToRedeem: usePoints ? centsToPoints(pointsDiscountCents) : 0,
    platformFeeCents,
    providerPayoutEstimateCents: finalChargeCents - platformFeeCents,
    commissionBps,
    pointsPerUsd: POINTS_PER_USD,
  };
}

function cleanOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGuestContact(contact: SecureHoldGuestContact | undefined): SecureHoldGuestContact {
  const email = cleanOptionalString(contact?.email)?.toLowerCase();
  return {
    email,
    name: cleanOptionalString(contact?.name),
    phone: cleanOptionalString(contact?.phone),
    postalCode: cleanOptionalString(contact?.postalCode),
    country: cleanOptionalString(contact?.country)?.toUpperCase(),
  };
}

async function ensureStripeCustomerForBookingUser(
  stripe: Stripe,
  user: BookingUserForCustomer,
  source: 'authenticated' | 'apple_pay_guest',
) {
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name ?? undefined,
    phone: user.phone ?? undefined,
    metadata: { userId: user.id, source },
  });
  await db.user.update({ where: { id: user.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

async function getOrCreateBookingStripeCustomer(stripe: Stripe, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: bookingUserForCustomerSelect,
  });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
  return ensureStripeCustomerForBookingUser(stripe, user, 'authenticated');
}

async function getOrCreateApplePayGuestBooker(stripe: Stripe, contactInput: SecureHoldGuestContact | undefined) {
  const contact = normalizeGuestContact(contactInput);
  if (!contact.email) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Guest Apple Pay secure holds require an email address from Apple Pay contact information.',
    });
  }

  let user = await db.user.findUnique({
    where: { email: contact.email },
    select: bookingUserForCustomerSelect,
  });
  if (!user) {
    user = await db.user.create({
      data: {
        email: contact.email,
        name: contact.name ?? contact.email.split('@')[0],
        phone: contact.phone ?? null,
        password: `apple-pay-guest:${randomUUID()}`,
        authProvider: 'apple_pay_guest',
        ref: 'app_clip.apple_pay_secure_hold',
      },
      select: bookingUserForCustomerSelect,
    });
  }

  const customerId = await ensureStripeCustomerForBookingUser(stripe, user, 'apple_pay_guest');
  return { user, customerId, contact };
}

function mapPatchSummary(patch: BookingPatchRow) {
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

function asMetadataObject(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return { ...(metadata as Record<string, unknown>) };
  }
  return {};
}

function mapBooking(booking: BookingRow) {
  return {
    id: booking.id,
    entity: booking.entity,
    status: booking.status,
    priceCents: booking.priceCents,
    platformFeeCents: booking.platformFeeCents,
    currency: booking.currency,
    stripeSessionId: booking.stripeSessionId,
    stripePaymentIntentId: booking.stripePaymentIntentId,
    stripeTransferDestination: booking.stripeTransferDestination,
    ictJti: booking.ictJti,
    scheduledFor: booking.scheduledFor?.toISOString() ?? null,
    completedAt: booking.completedAt?.toISOString() ?? null,
    metadata: booking.metadata ?? null,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    service: {
      id: booking.service.id,
      title: booking.service.title,
      description: booking.service.description,
      durationMins: booking.service.durationMins,
      status: booking.service.status,
      patch: isBoundServicePatch(booking.service.patch, booking.service.id)
        ? mapPatchSummary(booking.service.patch)
        : null,
    },
    vendor: {
      id: booking.vendor.id,
      displayName: booking.vendor.displayName,
    },
  };
}

export const bookingRouter = router({
  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 12, label: 'booking:create' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: bookingFrameworks,
        stateFlags: ['BOOKING_CREATE'],
        policyContext: { surface: 'booking', operation: 'create' },
      }),
    )
    .input(
      z.object({
        serviceId: z.string().min(1),
        scheduledFor: z.string().datetime().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        ttlSec: z.number().int().min(60).max(3600).optional().default(900),
        geo: z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().optional() }).optional(),
        device: z.object({ fingerprint: z.string().min(1).optional(), platform: z.string().min(1).optional() }).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = await (db.vendorService as any).findUnique({
        where: { id: input.serviceId },
        select: {
          id: true,
          title: true,
          description: true,
          tier: true,
          priceCents: true,
          currency: true,
          durationMins: true,
          status: true,
          vendor: {
            select: {
              id: true,
              displayName: true,
              commissionBps: true,
            },
          },
          patch: { select: patchSelect },
        },
      });

      if (!service) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor service not found' });
      if (service.status !== 'active') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Only active vendor services can be booked' });
      }

      const boundPatch = isBoundServicePatch(service.patch, service.id) ? service.patch : null;
      const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
      const ictJti = randomUUID();
      const platformFeeCents = Math.round(service.priceCents * (service.vendor.commissionBps / 10_000));
      const metadata = {
        ...input.metadata,
        flow: 'booking.create',
        serviceTitle: service.title,
        patch: boundPatch
          ? { id: boundPatch.id, uid: boundPatch.uid, label: boundPatch.label }
          : null,
      };

      const booking = await db.booking.create({
        data: {
          serviceId: service.id,
          vendorId: service.vendor.id,
          userId: ctx.user.userId,
          status: 'confirmed',
          priceCents: service.priceCents,
          platformFeeCents,
          currency: service.currency,
          tier: (service as any).tier ?? 'SIMPLE',
          requestStatus: 'ACCEPTED',
          ictJti,
          scheduledFor,
          metadata,
        } as any,
        select: bookingSelect,
      }) as unknown as BookingRow;

      const token = signICT(
        {
          sub: ctx.user.userId,
          action: 'vendor.booking',
          resource: { type: 'booking', id: booking.id },
          entity: Entity.VENDOR_SERVICES,
          vendorId: service.vendor.id,
          vendorName: service.vendor.displayName,
          serviceId: service.id,
          serviceTitle: service.title,
          patchId: boundPatch?.id ?? null,
          patchUid: boundPatch?.uid ?? null,
          scheduledFor: scheduledFor?.toISOString() ?? null,
          geo: input.geo,
          device: input.device,
          jti: ictJti,
        },
        { ttlSec: input.ttlSec },
      );

      return {
        booking: mapBooking(booking),
        access: {
          token,
          kid: getActiveICTKid(),
          ictJti,
          patch: boundPatch ? mapPatchSummary(boundPatch) : null,
        },
      };
    }),

  createCheckout: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 8, label: 'booking:createCheckout' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: bookingFrameworks,
        stateFlags: ['BOOKING_CREATE', 'MARKETPLACE_PAYMENT_CREATE'],
        policyContext: { surface: 'booking', operation: 'createCheckout' },
      }),
    )
    .input(
      z.object({
        serviceId: z.string().min(1),
        scheduledFor: z.string().datetime().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        usePoints: z.boolean().optional().default(false),
        successPath: z.string().trim().min(1).max(200).optional(),
        cancelPath: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payments are not configured.' });
      }

      const [service, pointTxns] = await Promise.all([
        (db.vendorService as any).findUnique({
          where: { id: input.serviceId },
          select: {
            id: true,
            title: true,
            description: true,
            tier: true,
            priceCents: true,
            currency: true,
            durationMins: true,
            status: true,
            vendor: {
              select: {
                id: true,
                displayName: true,
                commissionBps: true,
                stripeAccountId: true,
                onboardingStatus: true,
                entity: true,
              },
            },
            patch: { select: patchSelect },
          },
        }),
        db.pointTransaction.findMany({
          where: { userId: ctx.user.userId },
          select: { type: true, amount: true },
        }),
      ]);

      if (!service) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor service not found' });
      if (service.status !== 'active') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Only active vendor services can be booked' });
      }
      if (!service.vendor.stripeAccountId || service.vendor.onboardingStatus !== 'active') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Vendor Stripe Connect onboarding is not ready' });
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const entity = service.vendor.entity;
      const boundPatch = isBoundServicePatch(service.patch, service.id) ? service.patch : null;
      const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
      const offer = buildMarketplaceOffer(
        service.priceCents,
        service.vendor.commissionBps,
        getAvailablePoints(pointTxns),
        input.usePoints,
      );
      const stripeMetadata: Record<string, string> = {
        flow: 'booking.checkout',
        entity,
        userId: ctx.user.userId,
        vendorId: service.vendor.id,
        vendorName: service.vendor.displayName,
        serviceId: service.id,
        serviceTitle: service.title,
        patchId: boundPatch?.id ?? '',
        patchUid: boundPatch?.uid ?? '',
        basePriceCents: String(offer.basePriceCents),
        finalChargeCents: String(offer.finalChargeCents),
        platformFeeCents: String(offer.platformFeeCents),
        providerPayoutEstimateCents: String(offer.providerPayoutEstimateCents),
        commissionBps: String(offer.commissionBps),
        pointsToRedeem: String(offer.pointsToRedeem),
        pointsDiscountCents: String(offer.pointsDiscountCents),
        transferDestination: service.vendor.stripeAccountId,
      };
      const bookingMetadata = {
        ...input.metadata,
        ...stripeMetadata,
        patch: boundPatch ? { id: boundPatch.id, uid: boundPatch.uid, label: boundPatch.label } : null,
      };
      const requestExpiresAt = new Date(Date.now() + PROVIDER_REQUEST_TTL_MS);

      const booking = await db.booking.create({
        data: {
          serviceId: service.id,
          vendorId: service.vendor.id,
          userId: ctx.user.userId,
          entity,
          status: 'pending',
          priceCents: offer.finalChargeCents,
          platformFeeCents: offer.platformFeeCents,
          currency: service.currency,
          tier: (service as any).tier ?? 'SIMPLE',
          requestStatus: 'REQUESTED',
          requestExpiresAt,
          scheduledFor,
          stripeTransferDestination: service.vendor.stripeAccountId,
          metadata: {
            ...bookingMetadata,
            bookingBasePriceCents: offer.basePriceCents,
            bookingPendingAt: new Date().toISOString(),
          },
        } as any,
        select: bookingSelect,
      }) as unknown as BookingRow;

      const sessionMetadata = { ...stripeMetadata, bookingId: booking.id };
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: service.currency.toLowerCase(),
              unit_amount: offer.finalChargeCents,
              product_data: {
                name: service.title,
                description: service.description ?? `Bytspot service by ${service.vendor.displayName}`,
              },
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: offer.platformFeeCents,
          transfer_data: { destination: service.vendor.stripeAccountId },
          metadata: sessionMetadata,
        },
        metadata: sessionMetadata,
        success_url: `${config.frontendUrl}${input.successPath ?? '/booking/success'}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.frontendUrl}${input.cancelPath ?? '/booking/cancelled'}?booking_id=${booking.id}`,
      });

      const updatedBooking = await db.booking.update({
        where: { id: booking.id },
        data: {
          stripeSessionId: session.id,
          metadata: {
            ...sessionMetadata,
            stripeSessionId: session.id,
            checkoutUrlCreated: Boolean(session.url),
          },
        },
        select: bookingSelect,
      }) as unknown as BookingRow;
      await notifyVendorNewRequest({
        vendorId: service.vendor.id,
        bookingId: updatedBooking.id,
        serviceTitle: service.title,
        tier: updatedBooking.tier ?? (service as any).tier ?? 'SIMPLE',
        amountCents: updatedBooking.priceCents,
        currency: updatedBooking.currency,
        requestStatus: updatedBooking.requestStatus ?? 'REQUESTED',
        requestExpiresAt: updatedBooking.requestExpiresAt ?? requestExpiresAt,
      });

      return {
        url: session.url,
        booking: mapBooking(updatedBooking),
        moneyFlow: {
          entity,
          grossCents: offer.finalChargeCents,
          basePriceCents: offer.basePriceCents,
          applicationFeeAmount: offer.platformFeeCents,
          providerPayoutEstimateCents: offer.providerPayoutEstimateCents,
          transferDestination: service.vendor.stripeAccountId,
          pointsToRedeem: offer.pointsToRedeem,
          pointsDiscountCents: offer.pointsDiscountCents,
        },
      };
    }),

  authorizeApplePayHold: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 8, label: 'booking:authorizeApplePayHold' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: bookingFrameworks,
        stateFlags: ['BOOKING_CREATE', 'MARKETPLACE_PAYMENT_CREATE'],
        policyContext: { surface: 'booking', operation: 'authorizeApplePayHold' },
      }),
    )
    .input(
      z.object({
        serviceId: z.string().min(1),
        patchId: z.string().min(1).max(120).optional(),
        amountCents: z.number().int().min(MARKETPLACE_MIN_UNIT_AMOUNT_CENTS).max(500_000),
        currency: z.string().trim().min(3).max(3).default('usd'),
        stripePaymentMethodId: z.string().trim().startsWith('pm_').optional(),
        stripeTokenId: z.string().trim().startsWith('tok_').optional(),
        paymentNetworkToken: z.string().trim().max(20_000).optional(),
        scheduledFor: z.string().datetime().optional(),
        idempotencyKey: z.string().trim().min(8).max(120).optional(),
        guestContact: secureHoldGuestContactSchema,
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!config.stripeSecretKey) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Payments are not configured.' });
      }
      if (!config.stripeSecureHoldPaymentMethodConfigurationId) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Secure hold payment configuration is not configured.' });
      }
      if (!input.stripePaymentMethodId && !input.stripeTokenId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Apple Pay secure hold requires a Stripe payment method or token. Raw Apple Pay network tokens must be converted by the native Stripe SDK first.',
        });
      }

      const service = await (db.vendorService as any).findUnique({
        where: { id: input.serviceId },
        select: {
          id: true,
          title: true,
          description: true,
          tier: true,
          priceCents: true,
          currency: true,
          durationMins: true,
          status: true,
          vendor: {
            select: {
              id: true,
              displayName: true,
              commissionBps: true,
              stripeAccountId: true,
              onboardingStatus: true,
              entity: true,
            },
          },
          patch: { select: patchSelect },
        },
      });

      if (!service) throw new TRPCError({ code: 'NOT_FOUND', message: 'Vendor service not found' });
      if (service.status !== 'active') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Only active vendor services can be booked' });
      }
      if (!service.vendor.stripeAccountId || service.vendor.onboardingStatus !== 'active') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Vendor Stripe Connect onboarding is not ready' });
      }
      if (input.amountCents !== service.priceCents) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Secure hold amount does not match the service price.' });
      }
      if (input.currency.toUpperCase() !== service.currency.toUpperCase()) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Secure hold currency does not match the service currency.' });
      }

      const stripe = new Stripe(config.stripeSecretKey);
      const guestBooker = ctx.user ? null : await getOrCreateApplePayGuestBooker(stripe, input.guestContact);
      const bookingUserId = ctx.user?.userId ?? guestBooker?.user.id;
      if (!bookingUserId) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
      }
      const customerId = ctx.user ? await getOrCreateBookingStripeCustomer(stripe, ctx.user.userId) : guestBooker!.customerId;
      const bookingMode = ctx.user ? 'authenticated' : 'apple_pay_guest';
      const entity = service.vendor.entity;
      const boundPatch = isBoundServicePatch(service.patch, service.id) ? service.patch : null;
      if (input.patchId && boundPatch && ![boundPatch.id, boundPatch.uid].includes(input.patchId)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Patch does not match the selected service.' });
      }
      const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
      const offer = buildMarketplaceOffer(service.priceCents, service.vendor.commissionBps, 0, false);
      const stripeMetadata: Record<string, string> = {
        flow: 'booking.apple_pay_secure_hold',
        source: 'booking.authorizeApplePayHold',
        captureMode: 'manual',
        secureHoldStatus: 'authorization_requested',
        entity,
        userId: bookingUserId,
        bookingMode,
        guestEmailProvided: guestBooker?.contact.email ? 'true' : 'false',
        vendorId: service.vendor.id,
        vendorName: service.vendor.displayName,
        serviceId: service.id,
        serviceTitle: service.title,
        patchId: boundPatch?.id ?? input.patchId ?? '',
        patchUid: boundPatch?.uid ?? '',
        finalChargeCents: String(offer.finalChargeCents),
        platformFeeCents: String(offer.platformFeeCents),
        providerPayoutEstimateCents: String(offer.providerPayoutEstimateCents),
        commissionBps: String(offer.commissionBps),
        transferDestination: service.vendor.stripeAccountId,
      };
      const guestMetadata = guestBooker
        ? {
            guestContact: {
              email: guestBooker.contact.email,
              name: guestBooker.contact.name ?? null,
              phone: guestBooker.contact.phone ?? null,
              postalCode: guestBooker.contact.postalCode ?? null,
              country: guestBooker.contact.country ?? null,
            },
            guestLinking: { strategy: 'email_match_on_future_auth', userId: bookingUserId },
          }
        : { guestContact: null, guestLinking: null };
      const requestExpiresAt = new Date(Date.now() + PROVIDER_REQUEST_TTL_MS);

      const booking = await db.booking.create({
        data: {
          serviceId: service.id,
          vendorId: service.vendor.id,
          userId: bookingUserId,
          entity,
          status: 'pending',
          priceCents: offer.finalChargeCents,
          platformFeeCents: offer.platformFeeCents,
          currency: service.currency,
          tier: (service as any).tier ?? 'SIMPLE',
          requestStatus: 'REQUESTED',
          requestExpiresAt,
          scheduledFor,
          stripeTransferDestination: service.vendor.stripeAccountId,
          metadata: {
            ...input.metadata,
            ...stripeMetadata,
            ...guestMetadata,
            paymentMethodConfigurationId: config.stripeSecureHoldPaymentMethodConfigurationId,
            patch: boundPatch ? { id: boundPatch.id, uid: boundPatch.uid, label: boundPatch.label } : null,
          },
        } as any,
        select: bookingSelect,
      }) as unknown as BookingRow;

      const sessionMetadata = { ...stripeMetadata, bookingId: booking.id, secureHoldStatus: 'authorization_requested' };
      const paymentMethodData = input.stripeTokenId
        ? ({ type: 'card', card: { token: input.stripeTokenId } } as unknown as Stripe.PaymentIntentCreateParams.PaymentMethodData)
        : undefined;
      const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
        amount: offer.finalChargeCents,
        currency: service.currency.toLowerCase(),
        customer: customerId,
        capture_method: 'manual',
        confirm: true,
        payment_method: input.stripePaymentMethodId,
        payment_method_data: paymentMethodData,
        payment_method_configuration: config.stripeSecureHoldPaymentMethodConfigurationId,
        application_fee_amount: offer.platformFeeCents,
        transfer_data: { destination: service.vendor.stripeAccountId },
        metadata: sessionMetadata,
        description: `Bytspot secure hold — ${service.title}`,
      };
      const paymentIntent = await stripe.paymentIntents.create(
        paymentIntentParams,
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined,
      );

      const holdAuthorized = paymentIntent.status === 'requires_capture' || paymentIntent.status === 'succeeded';
      const updatedBooking = await db.booking.update({
        where: { id: booking.id },
        data: {
          status: holdAuthorized ? 'funds_authorized' : 'pending',
          requestStatus: holdAuthorized ? 'HOLD_AUTHORIZED' : 'REQUESTED',
          stripePaymentIntentId: paymentIntent.id,
          metadata: {
            ...sessionMetadata,
            ...guestMetadata,
            paymentIntentStatus: paymentIntent.status,
            secureHoldStatus: holdAuthorized ? 'funds_authorized' : 'requires_action',
            clientSecretCreated: Boolean(paymentIntent.client_secret),
          },
        } as any,
        select: bookingSelect,
      }) as unknown as BookingRow;
      await notifyVendorNewRequest({
        vendorId: service.vendor.id,
        bookingId: updatedBooking.id,
        serviceTitle: service.title,
        tier: updatedBooking.tier ?? (service as any).tier ?? 'SIMPLE',
        amountCents: updatedBooking.priceCents,
        currency: updatedBooking.currency,
        requestStatus: updatedBooking.requestStatus ?? (holdAuthorized ? 'HOLD_AUTHORIZED' : 'REQUESTED'),
        requestExpiresAt: updatedBooking.requestExpiresAt ?? requestExpiresAt,
        secureHoldAuthorized: holdAuthorized,
      });

      return {
        booking: mapBooking(updatedBooking),
        bookingId: updatedBooking.id,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        status: holdAuthorized ? 'funds_authorized' : paymentIntent.status,
        captureMode: 'manual' as const,
        guestMode: bookingMode === 'apple_pay_guest',
        message: holdAuthorized
          ? 'Secure hold authorized. Funds will be captured after service completion.'
          : 'Secure hold created. Additional payment confirmation may be required.',
        moneyFlow: {
          entity,
          grossCents: offer.finalChargeCents,
          applicationFeeAmount: offer.platformFeeCents,
          providerPayoutEstimateCents: offer.providerPayoutEstimateCents,
          transferDestination: service.vendor.stripeAccountId,
        },
      };
    }),

  listMine: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'booking:listMine' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: bookingFrameworks,
        stateFlags: ['BOOKING_READ'],
        policyContext: { surface: 'booking', operation: 'listMine' },
      }),
    )
    .input(z.object({ limit: z.number().int().min(1).max(50).optional().default(20) }).optional().default({}))
    .query(async ({ ctx, input }) => {
      const bookings = await db.booking.findMany({
        where: { userId: ctx.user.userId },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: bookingSelect,
      });

      return { bookings: (bookings as any[]).map((booking) => mapBooking(booking)) };
    }),

  get: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'booking:get' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: bookingFrameworks,
        stateFlags: ['BOOKING_READ'],
        policyContext: { surface: 'booking', operation: 'get' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const booking = await db.booking.findUnique({ where: { id: input.bookingId }, select: bookingSelect }) as unknown as BookingRow | null;
      if (!booking || booking.userId !== ctx.user.userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });
      }

      return mapBooking(booking);
    }),

  cancel: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'booking:cancel' }))
    .use(
      sovereignShieldMiddleware({
        entity: Entity.VENDOR_SERVICES,
        frameworks: bookingFrameworks,
        stateFlags: ['BOOKING_CANCEL'],
        policyContext: { surface: 'booking', operation: 'cancel' },
      }),
    )
    .input(z.object({ bookingId: z.string().min(1), reason: z.string().trim().min(1).max(280).optional() }))
    .mutation(async ({ ctx, input }) => {
      const booking = await db.booking.findUnique({ where: { id: input.bookingId }, select: bookingSelect }) as unknown as BookingRow | null;
      if (!booking || booking.userId !== ctx.user.userId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });
      }
      if (booking.status === 'completed' || booking.status === 'refunded') {
        throw new TRPCError({ code: 'CONFLICT', message: 'This booking can no longer be canceled' });
      }
      if (booking.status === 'canceled') {
        return {
          booking: mapBooking(booking),
          alreadyCanceled: true,
        };
      }

      const metadata = asMetadataObject(booking.metadata);
      const existingCancellation = metadata.cancellation;
      const cancellation =
        existingCancellation && typeof existingCancellation === 'object' && !Array.isArray(existingCancellation)
          ? { ...(existingCancellation as Record<string, unknown>) }
          : {};

      const canceledBooking = await db.booking.update({
        where: { id: booking.id },
        data: {
          status: 'canceled',
          metadata: {
            ...metadata,
            cancellation: {
              ...cancellation,
              reason: input.reason ?? cancellation.reason ?? null,
              canceledAt: new Date().toISOString(),
              canceledByUserId: ctx.user.userId,
              flow: 'booking.cancel',
            },
          },
        },
        select: bookingSelect,
      }) as unknown as BookingRow;

      return {
        booking: mapBooking(canceledBooking),
        alreadyCanceled: false,
      };
    }),
});