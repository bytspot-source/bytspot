import { TRPCError } from '@trpc/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { distanceMeters, startOfPointsDay } from '../services/checkinProof';
import { boundingBoxWhere } from '../services/geoBox';
import {
  CONFIRMED_REPORT_POINTS,
  DAILY_REPORT_POINT_CEILING,
  MAP_REPORT_KINDS,
  MERGE_METERS,
  REPORT_LIFETIME_MS,
  REPORT_SELECT,
  TRUST_WINDOW_MS,
  VENUE_REPORT_KINDS,
  activeReportsNear,
  evidenceWeight,
  judgeRow,
  publishMapReportChange,
  requiredAgreementFor,
  toPublicReport,
  type MapReportVoteKind,
  type PublicMapReport,
  type ReportRow,
} from '../services/mapReports';
import { protectedProcedure, publicProcedure, rateLimitMiddleware, router } from './trpc';

const HOUR_MS = 60 * 60 * 1000;
const METERS_PER_MILE = 1609.344;
/** A venue report has to come from someone in the area. */
const VENUE_REPORT_REACH_METERS = METERS_PER_MILE;

async function requireConfirmedEmail(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (!user?.emailVerifiedAt) throw new TRPCError({ code: 'FORBIDDEN', message: 'Confirm your email to report on the Map.' });
}

async function provenAtVenue(userId: string, venueId: string | null, now: Date): Promise<boolean> {
  if (!venueId) return false;
  const visit = await db.checkIn.findFirst({
    where: { userId, venueId, proof: { not: 'self_reported' }, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
    select: { id: true },
  });
  return visit !== null;
}

async function requiredAgreement(userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - TRUST_WINDOW_MS);
  const [confirmed, refuted] = await Promise.all([
    db.mapReport.count({ where: { reporterId: userId, createdAt: { gte: since }, confirmedAt: { not: null } } }),
    db.mapReport.count({ where: { reporterId: userId, createdAt: { gte: since }, confirmedAt: null, removedAt: { not: null } } }),
  ]);
  return requiredAgreementFor({ confirmed, refuted });
}

async function loadReport(id: string): Promise<ReportRow | null> {
  return (await db.mapReport.findUnique({ where: { id }, select: REPORT_SELECT })) as ReportRow | null;
}

/** The first confirmation wins the points; a confirmation racing it finds
 *  `confirmedAt` already set and pays nothing. */
async function confirmAndPay(row: ReportRow, now: Date): Promise<void> {
  const won = await db.mapReport.updateMany({ where: { id: row.id, confirmedAt: null }, data: { confirmedAt: now } });
  if (won.count !== 1) return;
  const earned = await db.mapReport.aggregate({
    _sum: { pointsEarned: true },
    where: { reporterId: row.reporterId, confirmedAt: { gte: startOfPointsDay(now) } },
  });
  const points = Math.min(CONFIRMED_REPORT_POINTS, DAILY_REPORT_POINT_CEILING - (earned._sum.pointsEarned ?? 0));
  if (points <= 0) return;
  await db.$transaction([
    db.mapReport.update({ where: { id: row.id }, data: { pointsEarned: points } }),
    db.pointTransaction.create({
      data: {
        userId: row.reporterId,
        type: 'earn',
        amount: points,
        description: row.venue ? `Map report confirmed at ${row.venue.name}` : 'Map report confirmed',
        category: 'map_report',
      },
    }),
  ]);
}

type Settled = { report: PublicMapReport; removed: boolean };

/** Re-judges a report after a change, stores what moved and tells the Map. */
async function settle(id: string, now: Date): Promise<Settled> {
  const row = await loadReport(id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That report has expired.' });
  const verdict = judgeRow(row, now);

  const data: Prisma.MapReportUpdateInput = {};
  if (verdict.expiresAt.getTime() !== row.expiresAt.getTime()) data.expiresAt = verdict.expiresAt;
  const removed = row.removedAt !== null || verdict.removed;
  if (verdict.removed && row.removedAt === null) data.removedAt = now;
  if (Object.keys(data).length > 0) await db.mapReport.update({ where: { id }, data });
  if (verdict.confirmed && row.confirmedAt === null) await confirmAndPay(row, now);

  const report = toPublicReport(row, verdict);
  await publishMapReportChange(removed ? { type: 'remove', id, lat: row.lat, lng: row.lng } : { type: 'upsert', report });
  return { report, removed };
}

async function castVote(reportId: string, voterId: string, vote: MapReportVoteKind, weight: number, now: Date): Promise<void> {
  await db.mapReportVote.upsert({
    where: { reportId_voterId: { reportId, voterId } },
    create: { reportId, voterId, vote, weight, votedAt: now },
    update: { vote, weight, votedAt: now },
  });
}

/** An active report of the same kind at the same venue, or close enough to the pin. */
async function sameThing(kind: string, pin: { lat: number; lng: number }, venueId: string | null, now: Date) {
  const candidates = await db.mapReport.findMany({
    where: {
      kind,
      removedAt: null,
      expiresAt: { gt: now },
      ...(venueId ? { venueId } : boundingBoxWhere(pin.lat, pin.lng, MERGE_METERS / METERS_PER_MILE)),
    },
    select: { id: true, reporterId: true, lat: true, lng: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return candidates.find((c) => venueId !== null || distanceMeters(pin, c) <= MERGE_METERS) ?? null;
}

const coordinate = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

/**
 * Traffic Intel reports. One member's report shows as unconfirmed; it is
 * confirmed when enough members agree within ten minutes, and removed when
 * enough say it's gone. Reporters and voters are never shown.
 */
export const mapReportsRouter = router({
  /** Active reports around a point, for the Map. Guests can read them. */
  list: publicProcedure
    .use(rateLimitMiddleware({ windowMs: 60_000, max: 60, label: 'map-reports-list' }))
    .input(z.object({ ...coordinate, radiusMiles: z.number().min(0.1).max(5).default(1) }))
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const rows = await activeReportsNear(input.lat, input.lng, input.radiusMiles, now);
      const viewer = ctx.user?.userId ?? null;
      return {
        reports: rows.map((row) => ({
          ...toPublicReport(row, judgeRow(row, now)),
          mine: viewer !== null && row.reporterId === viewer,
          myVote: (viewer ? row.votes.find((v) => v.voterId === viewer)?.vote ?? null : null) as MapReportVoteKind | null,
        })),
      };
    }),

  /**
   * Report what you see. The same kind of report already active nearby is the
   * same thing, so a second member's report agrees with it instead of adding
   * a pin, and a member's repeat returns their own report.
   */
  submit: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: HOUR_MS, max: 10, label: 'map-report' }))
    .input(z.object({
      kind: z.enum(MAP_REPORT_KINDS),
      ...coordinate,
      venueId: z.string().min(1).max(128).optional(),
      clientReportId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.userId;
      await requireConfirmedEmail(userId);
      const now = new Date();

      if (VENUE_REPORT_KINDS.has(input.kind) && !input.venueId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose the place this report is about.' });
      }
      const venue = input.venueId
        ? await db.venue.findUnique({ where: { id: input.venueId }, select: { id: true, lat: true, lng: true } })
        : null;
      if (input.venueId && !venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'That place was not found.' });
      if (venue && distanceMeters(input, venue) > VENUE_REPORT_REACH_METERS) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'You need to be near this place to report it.' });
      }
      const venueId = venue?.id ?? null;
      const pin = venue ? { lat: venue.lat, lng: venue.lng } : { lat: input.lat, lng: input.lng };

      if (input.clientReportId) {
        const retried = await db.mapReport.findUnique({
          where: { reporterId_clientReportId: { reporterId: userId, clientReportId: input.clientReportId } },
          select: { id: true },
        });
        if (retried) return { ...(await settle(retried.id, now)), merged: false };
      }

      const existing = await sameThing(input.kind, pin, venueId, now);
      if (existing) {
        if (existing.reporterId === userId) return { ...(await settle(existing.id, now)), merged: false };
        await castVote(existing.id, userId, 'still', evidenceWeight(await provenAtVenue(userId, venueId, now)), now);
        return { ...(await settle(existing.id, now)), merged: true };
      }

      const [proven, required] = await Promise.all([provenAtVenue(userId, venueId, now), requiredAgreement(userId, now)]);
      let id: string;
      try {
        ({ id } = await db.mapReport.create({
          data: {
            reporterId: userId,
            kind: input.kind,
            lat: pin.lat,
            lng: pin.lng,
            venueId,
            clientReportId: input.clientReportId ?? null,
            weight: evidenceWeight(proven),
            requiredAgreement: required,
            expiresAt: new Date(now.getTime() + REPORT_LIFETIME_MS),
            createdAt: now,
          },
          select: { id: true },
        }));
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && input.clientReportId)) throw error;
        const retried = await db.mapReport.findUnique({
          where: { reporterId_clientReportId: { reporterId: userId, clientReportId: input.clientReportId } },
          select: { id: true },
        });
        if (!retried) throw error;
        id = retried.id;
      }
      return { ...(await settle(id, now)), merged: false };
    }),

  /** "Still there" or "Gone". A member can change their vote; their own report isn't theirs to vote on. */
  vote: protectedProcedure
    .use(rateLimitMiddleware({ windowMs: HOUR_MS, max: 60, label: 'map-report-vote' }))
    .input(z.object({ reportId: z.string().min(1).max(128), vote: z.enum(['still', 'gone']) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.userId;
      await requireConfirmedEmail(userId);
      const now = new Date();
      const report = await db.mapReport.findFirst({
        where: { id: input.reportId, removedAt: null, expiresAt: { gt: now } },
        select: { reporterId: true, venueId: true },
      });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'That report has expired.' });
      if (report.reporterId === userId) throw new TRPCError({ code: 'BAD_REQUEST', message: "You can't vote on your own report." });
      await castVote(input.reportId, userId, input.vote, evidenceWeight(await provenAtVenue(userId, report.venueId, now)), now);
      return settle(input.reportId, now);
    }),
});
