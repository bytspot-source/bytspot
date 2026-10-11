import { EventEmitter } from 'events';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { captureError } from '../lib/observability';
import { distanceMeters } from './checkinProof';
import { boundingBoxWhere } from './geoBox';

/** What a member can report on the Map. The first three are on the road; the
 *  rest are about a place, and `long_line` and `packed` need the venue. */
export const MAP_REPORT_KINDS = ['police', 'construction', 'incident', 'long_line', 'packed', 'parking_full'] as const;
export type MapReportKind = (typeof MAP_REPORT_KINDS)[number];
export const VENUE_REPORT_KINDS: ReadonlySet<MapReportKind> = new Set(['long_line', 'packed']);

export type MapReportVoteKind = 'still' | 'gone';

/** A report lives this long after its last agreement, matching the Traffic
 *  Intel freshness window in the app. */
export const REPORT_LIFETIME_MS = 30 * 60 * 1000;
/** However often it is agreed with, a report is gone two hours after it was made. */
export const MAX_REPORT_AGE_MS = 2 * 60 * 60 * 1000;
/** Agreement only counts when it is recent: two members ten minutes apart are
 *  seeing the same thing, an hour apart they may not be. */
export const AGREEMENT_WINDOW_MS = 10 * 60 * 1000;
/** The same kind of report this close to an active one is the same thing. */
export const MERGE_METERS = 150;

export const DEFAULT_REQUIRED_AGREEMENT = 2;
export const LOW_TRUST_REQUIRED_AGREEMENT = 3;
export const GONE_TO_REMOVE_UNCONFIRMED = 2;
export const GONE_TO_REMOVE_CONFIRMED = 3;

/** Trust looks at this much of a member's own history. */
export const TRUST_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Points go to the reporter only once someone else confirms the report, so
 *  an unconfirmed or false report earns nothing. */
export const CONFIRMED_REPORT_POINTS = 5;
export const DAILY_REPORT_POINT_CEILING = 25;

/** A member who was at the venue — a proven check-in there in the last hour —
 *  counts as two. Everyone else counts as one. */
export function evidenceWeight(provenCheckInAtVenue: boolean): number {
  return provenCheckInAtVenue ? 2 : 1;
}

/** Reports voted gone before anyone confirmed them were wrong. A member with
 *  more of those than confirmed reports needs one more person to agree. */
export function requiredAgreementFor(history: { confirmed: number; refuted: number }): number {
  return history.refuted >= 2 && history.refuted > history.confirmed ? LOW_TRUST_REQUIRED_AGREEMENT : DEFAULT_REQUIRED_AGREEMENT;
}

export type ReportVote = { vote: MapReportVoteKind; weight: number; votedAt: Date };

export type ReportVerdict = {
  /** Enough recent agreement now, or already confirmed earlier. */
  confirmed: boolean;
  /** Enough "Gone" since the last agreement. */
  removed: boolean;
  expiresAt: Date;
  agreeCount: number;
  goneCount: number;
};

/**
 * Decides a report's state from its votes. Pure, so the same rule runs for a
 * new report, a merged one and a vote.
 *
 * - Confirmed: the reporter and members voting "Still there" in the last ten
 *   minutes add up to the report's required agreement. Once confirmed it
 *   stays confirmed.
 * - Removed: "Gone" votes cast after the latest agreement reach 2, or 3 for a
 *   confirmed report. An agreement after them resets the count.
 * - Expiry: thirty minutes after the latest agreement, at most two hours
 *   after the report was made.
 */
export function judgeReport(input: {
  createdAt: Date;
  weight: number;
  requiredAgreement: number;
  confirmedAt: Date | null;
  votes: ReportVote[];
  now: Date;
}): ReportVerdict {
  const windowStart = input.now.getTime() - AGREEMENT_WINDOW_MS;
  const still = input.votes.filter((v) => v.vote === 'still');
  const gone = input.votes.filter((v) => v.vote === 'gone');

  const recentAgreement =
    (input.createdAt.getTime() >= windowStart ? input.weight : 0) +
    still.filter((v) => v.votedAt.getTime() >= windowStart).reduce((sum, v) => sum + v.weight, 0);
  const confirmed = input.confirmedAt !== null || recentAgreement >= input.requiredAgreement;

  const lastAgreement = Math.max(input.createdAt.getTime(), ...still.map((v) => v.votedAt.getTime()));
  const goneSince = gone.filter((v) => v.votedAt.getTime() > lastAgreement).reduce((sum, v) => sum + v.weight, 0);
  const removed = goneSince >= (confirmed ? GONE_TO_REMOVE_CONFIRMED : GONE_TO_REMOVE_UNCONFIRMED);

  const expiresAt = new Date(Math.min(input.createdAt.getTime() + MAX_REPORT_AGE_MS, lastAgreement + REPORT_LIFETIME_MS));
  return { confirmed, removed, expiresAt, agreeCount: 1 + still.length, goneCount: gone.length };
}

/** What anyone on the Map may see. Never who reported or voted. */
export type PublicMapReport = {
  id: string;
  kind: MapReportKind;
  lat: number;
  lng: number;
  venueId: string | null;
  venueName: string | null;
  status: 'unconfirmed' | 'confirmed';
  agreeCount: number;
  goneCount: number;
  createdAt: string;
  expiresAt: string;
};

export const REPORT_SELECT = {
  id: true,
  reporterId: true,
  kind: true,
  lat: true,
  lng: true,
  venueId: true,
  weight: true,
  requiredAgreement: true,
  confirmedAt: true,
  removedAt: true,
  expiresAt: true,
  createdAt: true,
  venue: { select: { name: true } },
  votes: { select: { voterId: true, vote: true, weight: true, votedAt: true } },
} as const;

export type ReportRow = {
  id: string;
  reporterId: string;
  kind: string;
  lat: number;
  lng: number;
  venueId: string | null;
  weight: number;
  requiredAgreement: number;
  confirmedAt: Date | null;
  removedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  venue: { name: string } | null;
  votes: { voterId: string; vote: string; weight: number; votedAt: Date }[];
};

export function judgeRow(row: ReportRow, now: Date): ReportVerdict {
  return judgeReport({
    createdAt: row.createdAt,
    weight: row.weight,
    requiredAgreement: row.requiredAgreement,
    confirmedAt: row.confirmedAt,
    votes: row.votes.map((v) => ({ vote: v.vote === 'gone' ? 'gone' : 'still', weight: v.weight, votedAt: v.votedAt })),
    now,
  });
}

export function toPublicReport(row: ReportRow, verdict: ReportVerdict): PublicMapReport {
  return {
    id: row.id,
    kind: row.kind as MapReportKind,
    lat: row.lat,
    lng: row.lng,
    venueId: row.venueId,
    venueName: row.venue?.name ?? null,
    status: verdict.confirmed ? 'confirmed' : 'unconfirmed',
    agreeCount: verdict.agreeCount,
    goneCount: verdict.goneCount,
    createdAt: row.createdAt.toISOString(),
    expiresAt: verdict.expiresAt.toISOString(),
  };
}

const MAX_LISTED_REPORTS = 200;

/** Active reports within the radius, nearest-first filtering on true distance.
 *  A suspended or deleted reporter's reports are not shown. */
export async function activeReportsNear(lat: number, lng: number, radiusMiles: number, now: Date): Promise<ReportRow[]> {
  const rows = (await db.mapReport.findMany({
    where: {
      removedAt: null,
      expiresAt: { gt: now },
      reporter: { suspendedAt: null, deletedAt: null },
      ...boundingBoxWhere(lat, lng, radiusMiles),
    },
    select: REPORT_SELECT,
    orderBy: { createdAt: 'desc' },
    take: MAX_LISTED_REPORTS,
  })) as ReportRow[];
  const radiusMeters = radiusMiles * 1609.344;
  return rows.filter((row) => distanceMeters({ lat, lng }, row) <= radiusMeters);
}

export function withinRadius(center: { lat: number; lng: number }, radiusMiles: number, point: { lat: number; lng: number }): boolean {
  return distanceMeters(center, point) <= radiusMiles * 1609.344;
}

export type MapReportChange =
  | { type: 'upsert'; report: PublicMapReport }
  | { type: 'remove'; id: string; lat: number; lng: number };

// Live changes reach every copy of the API through Redis; with no Redis there
// is one copy, and the local emitter is the whole channel.
const CHANNEL = 'map-reports';
const local = new EventEmitter();
local.setMaxListeners(500);
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  const redis = getRedis();
  if (!redis) return;
  subscribed = true;
  const subscriber = redis.duplicate();
  subscriber.on('error', (error) => console.error('[map-reports] subscriber error:', error.message));
  subscriber.on('message', (_channel: string, message: string) => {
    try {
      local.emit('change', JSON.parse(message) as MapReportChange);
    } catch {
      /* a malformed message is dropped */
    }
  });
  subscriber.subscribe(CHANNEL).catch((error) => {
    subscribed = false;
    captureError(error, { flow: 'map-reports-subscribe' });
  });
}

export async function publishMapReportChange(change: MapReportChange): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.publish(CHANNEL, JSON.stringify(change));
      return;
    } catch {
      /* Redis down: this copy's members still get it */
    }
  }
  local.emit('change', change);
}

export function onMapReportChange(listener: (change: MapReportChange) => void): () => void {
  ensureSubscribed();
  local.on('change', listener);
  return () => local.off('change', listener);
}
