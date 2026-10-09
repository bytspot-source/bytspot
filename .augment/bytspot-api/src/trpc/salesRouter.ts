import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router } from './trpc';
import {
  MAX_BUYERS_PER_SALE,
  PAYMENT_PROVIDERS,
  SALE_UNAVAILABLE,
  handleUrl,
  meetWindowProblem,
  normalizeHandle,
  paymentReminder,
  saleLimits,
  saleState,
  snapMeetPoint,
  type PaymentProvider,
} from '../services/privateSales';

/**
 * Private sales. The meet point leaves this router only for the seller and
 * for a buyer the seller approved, and only while the sale is open. A sale
 * that ended, sold, was cancelled or belongs to a deleted account reads
 * exactly like one that never existed.
 */

const provider = z.enum(PAYMENT_PROVIDERS);
const saleId = z.object({ saleId: z.string().min(1).max(64) });
const requestId = z.object({ requestId: z.string().min(1).max(64) });

const unavailable = () => new TRPCError({ code: 'NOT_FOUND', message: SALE_UNAVAILABLE });

/** An open sale whose seller still has an account, or NOT_FOUND. */
async function liveSale(id: string, now = new Date()) {
  const sale = await db.privateSale.findFirst({
    where: { id, status: 'open', windowEnd: { gt: now }, seller: { deletedAt: null } },
    include: { seller: { select: { name: true } } },
  });
  if (!sale) throw unavailable();
  return sale;
}

async function ownSale(sellerId: string, id: string) {
  const sale = await db.privateSale.findFirst({ where: { id, sellerId } });
  if (!sale) throw unavailable();
  return sale;
}

/** A request on one of the caller's own open sales, or NOT_FOUND. */
async function ownRequest(sellerId: string, id: string, now = new Date()) {
  const request = await db.privateSaleRequest.findFirst({
    where: { id, sale: { sellerId, status: 'open', windowEnd: { gt: now } } },
    include: { sale: { select: { id: true, buyerLimit: true } } },
  });
  if (!request) throw unavailable();
  return request;
}

async function limitsFor(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { membershipTier: true } });
  return saleLimits(user?.membershipTier);
}

function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || 'Seller';
}

function serializeHandle(row: { provider: string; handle: string; displayName: string; confirmedAt: Date }) {
  const p = row.provider as PaymentProvider;
  return { provider: p, handle: row.handle, displayName: row.displayName, confirmedAt: row.confirmedAt, url: handleUrl(p, row.handle) };
}

const handlesRouter = router({
  list: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'sales-handles-list' }))
    .query(async ({ ctx }) => {
      const rows = await db.sellerPaymentHandle.findMany({
        where: { userId: ctx.user.userId, removedAt: null },
        orderBy: { provider: 'asc' },
      });
      return { handles: rows.map(serializeHandle) };
    }),

  /**
   * The seller confirms the handle is theirs (they opened it and saw this
   * name) and that it accepts goods-and-services payments. Neither can be
   * checked with the providers, so both are required statements.
   */
  save: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'sales-handles-save' }))
    .input(z.object({
      provider,
      handle: z.string().min(1).max(80),
      displayName: z.string().trim().min(1).max(80),
      ownershipConfirmed: z.literal(true),
      goodsAndServices: z.literal(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const handle = normalizeHandle(input.provider, input.handle);
      if (!handle) throw new TRPCError({ code: 'BAD_REQUEST', message: 'That handle does not look right for this provider.' });
      const data = { handle, displayName: input.displayName, confirmedAt: new Date(), removedAt: null };
      const row = await db.sellerPaymentHandle.upsert({
        where: { userId_provider: { userId: ctx.user.userId, provider: input.provider } },
        create: { userId: ctx.user.userId, provider: input.provider, ...data },
        update: data,
      });
      return serializeHandle(row);
    }),

  remove: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'sales-handles-remove' }))
    .input(z.object({ provider }))
    .mutation(async ({ ctx, input }) => {
      await db.sellerPaymentHandle.updateMany({
        where: { userId: ctx.user.userId, provider: input.provider, removedAt: null },
        data: { removedAt: new Date() },
      });
      return { removed: true };
    }),
});

export const salesRouter = router({
  handles: handlesRouter,

  create: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'sales-create' }))
    .input(z.object({
      title: z.string().trim().min(3).max(80),
      priceCents: z.number().int().min(0).max(10_000_000),
      meetPoint: z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        placeName: z.string().trim().min(2).max(80),
        areaLabel: z.string().trim().min(2).max(60).optional(),
      }),
      windowStart: z.coerce.date(),
      windowEnd: z.coerce.date(),
      buyerLimit: z.number().int().min(1).max(MAX_BUYERS_PER_SALE).default(1),
      providers: z.array(provider).min(1).max(PAYMENT_PROVIDERS.length),
    }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const problem = meetWindowProblem(input.windowStart, input.windowEnd, now);
      if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem });

      const providers = [...new Set(input.providers)];
      const saved = await db.sellerPaymentHandle.findMany({
        where: { userId: ctx.user.userId, removedAt: null, provider: { in: providers } },
        select: { provider: true },
      });
      if (saved.length !== providers.length) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Save a payment handle for each provider first.' });
      }

      const limits = await limitsFor(ctx.user.userId);
      if (input.buyerLimit > limits.buyersPerSale) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `Your membership allows up to ${limits.buyersPerSale} buyer${limits.buyersPerSale === 1 ? '' : 's'} per sale.` });
      }
      if (limits.openSales !== null) {
        const open = await db.privateSale.count({ where: { sellerId: ctx.user.userId, status: 'open', windowEnd: { gt: now } } });
        if (open >= limits.openSales) {
          throw new TRPCError({ code: 'FORBIDDEN', message: `Your membership allows ${limits.openSales} open sale${limits.openSales === 1 ? '' : 's'} at a time.` });
        }
      }

      const point = snapMeetPoint(input.meetPoint.lat, input.meetPoint.lng);
      const sale = await db.privateSale.create({
        data: {
          sellerId: ctx.user.userId,
          title: input.title,
          priceCents: input.priceCents,
          providers,
          meetPlaceName: input.meetPoint.placeName,
          meetLat: point.lat,
          meetLng: point.lng,
          meetAreaLabel: input.meetPoint.areaLabel ?? null,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          buyerLimit: input.buyerLimit,
        },
      });
      return { saleId: sale.id, shareUrl: `https://bytspot.app/sale/${sale.id}` };
    }),

  /** Moves the meet window of an open sale. */
  update: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'sales-update' }))
    .input(saleId.extend({ windowStart: z.coerce.date(), windowEnd: z.coerce.date() }))
    .mutation(async ({ ctx, input }) => {
      const sale = await ownSale(ctx.user.userId, input.saleId);
      if (saleState(sale) !== 'open') throw unavailable();
      const problem = meetWindowProblem(input.windowStart, input.windowEnd);
      if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem });
      await db.privateSale.update({ where: { id: sale.id }, data: { windowStart: input.windowStart, windowEnd: input.windowEnd } });
      return { saleId: sale.id };
    }),

  /** Sold or cancelled: the link closes at once for every buyer. */
  close: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 20, label: 'sales-close' }))
    .input(saleId.extend({ outcome: z.enum(['sold', 'cancelled']) }))
    .mutation(async ({ ctx, input }) => {
      const sale = await ownSale(ctx.user.userId, input.saleId);
      if (sale.status !== 'open') return { saleId: sale.id, state: sale.status as 'sold' | 'cancelled' };
      await db.privateSale.update({ where: { id: sale.id }, data: { status: input.outcome, closedAt: new Date() } });
      return { saleId: sale.id, state: input.outcome };
    }),

  /** The seller's sales, newest first, with who asked for the meet point and their membership limits. */
  mine: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'sales-mine' }))
    .query(async ({ ctx }) => {
      const now = new Date();
      const limits = await limitsFor(ctx.user.userId);
      const sales = await db.privateSale.findMany({
        where: { sellerId: ctx.user.userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { requests: { orderBy: { createdAt: 'asc' }, include: { buyer: { select: { name: true } } } } },
      });
      return {
        limits,
        sales: sales.map((sale) => ({
          saleId: sale.id,
          title: sale.title,
          priceCents: sale.priceCents,
          state: saleState(sale, now),
          shareUrl: `https://bytspot.app/sale/${sale.id}`,
          meetPoint: sale.meetLat !== null && sale.meetLng !== null
            ? { lat: sale.meetLat, lng: sale.meetLng, placeName: sale.meetPlaceName, areaLabel: sale.meetAreaLabel }
            : null,
          windowStart: sale.windowStart,
          windowEnd: sale.windowEnd,
          buyerLimit: sale.buyerLimit,
          providers: sale.providers,
          requests: sale.requests.map((r) => ({
            requestId: r.id,
            buyerName: firstName(r.buyer.name),
            status: r.status,
            arrivedAt: r.arrivedAt,
            createdAt: r.createdAt,
          })),
        })),
      };
    }),

  /**
   * What a share link shows. Signed out: title and price. Signed in: plus the
   * neighborhood and the caller's own request. Never the meet point.
   */
  view: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'sales-view' }))
    .input(saleId)
    .query(async ({ ctx, input }) => {
      const sale = await liveSale(input.saleId);
      const isSeller = ctx.user?.userId === sale.sellerId;
      const request = ctx.user && !isSeller
        ? await db.privateSaleRequest.findUnique({
            where: { saleId_buyerId: { saleId: sale.id, buyerId: ctx.user.userId } },
            select: { status: true },
          })
        : null;
      return {
        saleId: sale.id,
        title: sale.title,
        priceCents: sale.priceCents,
        sellerName: firstName(sale.seller.name),
        windowStart: sale.windowStart,
        windowEnd: sale.windowEnd,
        areaLabel: ctx.user ? sale.meetAreaLabel : null,
        isSeller,
        myRequest: request?.status ?? null,
      };
    }),

  request: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'sales-request' }))
    .input(saleId)
    .mutation(async ({ ctx, input }) => {
      const sale = await liveSale(input.saleId);
      if (sale.sellerId === ctx.user.userId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'This is your own sale.' });
      const key = { saleId_buyerId: { saleId: sale.id, buyerId: ctx.user.userId } };
      const existing = await db.privateSaleRequest.findUnique({ where: key, select: { status: true } });
      if (existing) return { status: existing.status };
      try {
        const created = await db.privateSaleRequest.create({ data: { saleId: sale.id, buyerId: ctx.user.userId } });
        return { status: created.status };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const concurrent = await db.privateSaleRequest.findUnique({ where: key, select: { status: true } });
          if (concurrent) return { status: concurrent.status };
        }
        throw error;
      }
    }),

  approve: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'sales-approve' }))
    .input(requestId)
    .mutation(async ({ ctx, input }) => {
      const request = await ownRequest(ctx.user.userId, input.requestId);
      if (request.status === 'approved') return { status: 'approved' };
      const approved = await db.privateSaleRequest.count({ where: { saleId: request.sale.id, status: 'approved' } });
      if (approved >= request.sale.buyerLimit) {
        throw new TRPCError({ code: 'CONFLICT', message: 'This sale already has as many approved buyers as it allows.' });
      }
      await db.privateSaleRequest.update({ where: { id: request.id }, data: { status: 'approved', decidedAt: new Date() } });
      return { status: 'approved' };
    }),

  /** Declining an approved buyer takes the meet point away from them too. */
  decline: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'sales-decline' }))
    .input(requestId)
    .mutation(async ({ ctx, input }) => {
      const request = await ownRequest(ctx.user.userId, input.requestId);
      await db.privateSaleRequest.update({ where: { id: request.id }, data: { status: 'declined', decidedAt: new Date() } });
      return { status: 'declined' };
    }),

  /** The approved buyer's card: meet point, window and the seller's handles. */
  buyerCard: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'sales-buyer-card' }))
    .input(saleId)
    .query(async ({ ctx, input }) => {
      const sale = await liveSale(input.saleId);
      const request = await db.privateSaleRequest.findUnique({
        where: { saleId_buyerId: { saleId: sale.id, buyerId: ctx.user.userId } },
        select: { status: true, arrivedAt: true },
      });
      if (request?.status !== 'approved' || sale.meetLat === null || sale.meetLng === null) throw unavailable();
      const handles = await db.sellerPaymentHandle.findMany({
        where: { userId: sale.sellerId, removedAt: null, provider: { in: sale.providers } },
        orderBy: { provider: 'asc' },
      });
      return {
        saleId: sale.id,
        title: sale.title,
        priceCents: sale.priceCents,
        sellerName: firstName(sale.seller.name),
        meetPoint: { lat: sale.meetLat, lng: sale.meetLng, placeName: sale.meetPlaceName, areaLabel: sale.meetAreaLabel },
        windowStart: sale.windowStart,
        windowEnd: sale.windowEnd,
        arrivedAt: request.arrivedAt,
        pay: handles.map((row) => ({
          ...serializeHandle(row),
          label: 'Seller-confirmed handle',
          reminder: paymentReminder(row.provider as PaymentProvider),
        })),
      };
    }),

  /** Optional: the approved buyer tells the seller they are at the meet point. */
  arrived: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 10, label: 'sales-arrived' }))
    .input(saleId)
    .mutation(async ({ ctx, input }) => {
      const sale = await liveSale(input.saleId);
      const { count } = await db.privateSaleRequest.updateMany({
        where: { saleId: sale.id, buyerId: ctx.user.userId, status: 'approved' },
        data: { arrivedAt: new Date() },
      });
      if (count === 0) throw unavailable();
      return { arrived: true };
    }),
});
