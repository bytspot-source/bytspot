import type { PrismaClient } from '@prisma/client';

/**
 * The venue and arrival time a Plan item can honestly carry.
 *
 * The order matches a plan leg. A won offer has agreed both, so it outranks
 * the party behind it. A party states its own start and, when the host picked
 * one, its arrival venue. A place item states a venue only when a Venue row
 * shares its Google place id, and a time only when the guest said when they
 * booked. A coffee hold states neither: a hold expiry is not an arrival.
 *
 * Null stays null. Nothing here invents "now" or a nearby venue.
 */
export interface PlanStopStamp {
  venueId: string | null;
  arrivesAt: Date | null;
}

export function stampForPlanItem(input: {
  offerStartsAt?: Date | null;
  offerMenuVenueId?: string | null;
  partyStartsAt?: Date | null;
  partyArrivalVenueId?: string | null;
  placeVenueId?: string | null;
  guestBookedFor?: Date | null;
}): PlanStopStamp {
  const venueId = knownId(input.offerMenuVenueId)
    ?? knownId(input.partyArrivalVenueId)
    ?? knownId(input.placeVenueId);
  const arrivesAt = knownInstant(input.offerStartsAt)
    ?? knownInstant(input.partyStartsAt)
    ?? knownInstant(input.guestBookedFor);
  return { venueId, arrivesAt };
}

function knownId(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function knownInstant(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

/** One Plan item, reduced to the facts the backfill is allowed to read. */
export interface PlanStopRow {
  id: string;
  venueId: string | null;
  arrivesAt: Date | null;
  placeId: string | null;
  guestBookedFor: Date | null;
  party: { startsAt: Date; arrivalVenueId: string | null } | null;
  offer: { startsAt: Date; location: { menuVenueId: string | null } } | null;
}

/**
 * Fields still null that the row's supply can now fill.
 *
 * A value already written is left alone, so a later run cannot overwrite a
 * stop someone has since corrected. Returns null when there is nothing new
 * to write, which is the steady state for coffee and for any other stop
 * whose venue or time was never stated.
 */
export function planStopPatch(
  row: PlanStopRow,
  placeVenueId: string | null,
): { venueId?: string; arrivesAt?: Date } | null {
  const derived = stampForPlanItem({
    offerStartsAt: row.offer?.startsAt ?? null,
    offerMenuVenueId: row.offer?.location.menuVenueId ?? null,
    partyStartsAt: row.party?.startsAt ?? null,
    partyArrivalVenueId: row.party?.arrivalVenueId ?? null,
    placeVenueId,
    guestBookedFor: row.guestBookedFor,
  });
  const data: { venueId?: string; arrivesAt?: Date } = {};
  if (row.venueId == null && derived.venueId) data.venueId = derived.venueId;
  if (row.arrivesAt == null && derived.arrivesAt) data.arrivesAt = derived.arrivesAt;
  return data.venueId || data.arrivesAt ? data : null;
}

export interface PlanStopStore {
  listIncomplete(cursor: string | null, take: number): Promise<PlanStopRow[]>;
  venuesForPlaceIds(placeIds: string[]): Promise<{ id: string; googlePlaceId: string }[]>;
  write(id: string, data: { venueId?: string; arrivesAt?: Date }): Promise<void>;
}

export interface PlanStopBackfillReport {
  examined: number;
  updated: number;
  venueFilled: number;
  arrivalFilled: number;
  /** Rows whose missing venue or time cannot be derived from current supply. */
  underived: number;
}

/**
 * Fill venue and arrival on items that do not have them yet.
 *
 * Not called from startup or from a request. The script that runs this
 * refuses production. A dry run counts the writes and performs none.
 */
export async function backfillPlanStops(
  store: PlanStopStore,
  options?: { dryRun?: boolean; batchSize?: number },
): Promise<PlanStopBackfillReport> {
  const batchSize = options?.batchSize ?? 200;
  const report: PlanStopBackfillReport = { examined: 0, updated: 0, venueFilled: 0, arrivalFilled: 0, underived: 0 };
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.listIncomplete(cursor, batchSize);
    if (rows.length === 0) break;
    const placeIds = [...new Set(rows.flatMap((row) => (row.venueId == null && row.placeId ? [row.placeId] : [])))];
    const venues = placeIds.length > 0 ? await store.venuesForPlaceIds(placeIds) : [];
    const byPlace = new Map(venues.map((venue) => [venue.googlePlaceId, venue.id]));
    for (const row of rows) {
      report.examined += 1;
      const patch = planStopPatch(row, row.placeId ? byPlace.get(row.placeId) ?? null : null);
      if (!patch) {
        report.underived += 1;
        continue;
      }
      if (patch.venueId) report.venueFilled += 1;
      if (patch.arrivesAt) report.arrivalFilled += 1;
      report.updated += 1;
      if (!options?.dryRun) await store.write(row.id, patch);
    }
    cursor = rows[rows.length - 1]?.id ?? cursor;
    if (rows.length < batchSize) break;
  }
  return report;
}

type PlanStopDb = Pick<PrismaClient, 'planItem' | 'venue'>;

/** The store the script uses. Tests pass their own. */
export function planStopStore(db: PlanStopDb): PlanStopStore {
  return {
    async listIncomplete(cursor, take) {
      return db.planItem.findMany({
        where: { OR: [{ venueId: null }, { arrivesAt: null }] },
        orderBy: { id: 'asc' },
        take,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          venueId: true,
          arrivesAt: true,
          placeId: true,
          guestBookedFor: true,
          party: { select: { startsAt: true, arrivalVenueId: true } },
          offer: { select: { startsAt: true, location: { select: { menuVenueId: true } } } },
        },
      });
    },
    async venuesForPlaceIds(placeIds) {
      if (placeIds.length === 0) return [];
      const rows = await db.venue.findMany({
        where: { googlePlaceId: { in: placeIds } },
        select: { id: true, googlePlaceId: true },
      });
      return rows.flatMap((row) => (row.googlePlaceId ? [{ id: row.id, googlePlaceId: row.googlePlaceId }] : []));
    },
    async write(id, data) {
      await db.planItem.update({ where: { id }, data });
    },
  };
}

/**
 * Whether this process may run the backfill. Production, Render, and a
 * database host on render.com are refused even when the opt-in is set.
 * The error never includes the database URL.
 */
export function assertBackfillAllowed(env: NodeJS.ProcessEnv): void {
  const reasons: string[] = [];
  if (env.BYTSPOT_BACKFILL_PLAN_STOPS !== '1') reasons.push('set BYTSPOT_BACKFILL_PLAN_STOPS=1');
  if (env.NODE_ENV === 'production') reasons.push('NODE_ENV is production');
  if (env.RENDER) reasons.push('RENDER is set');
  const host = databaseHost(env.DATABASE_URL);
  if (host && (host === 'render.com' || host.endsWith('.render.com') || host.endsWith('.render.internal'))) {
    reasons.push('DATABASE_URL points at Render');
  }
  if (reasons.length > 0) {
    throw new Error(`Refusing plan-stop backfill (${reasons.join('; ')}). This script is not part of deploy.`);
  }
}

function databaseHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
