import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { deliverPushNotification } from './notificationDelivery';
import { legsForPlan, type PlanLeg } from './planLegs';

const HOUR_MS = 60 * 60 * 1000;
/** A Plan is live from shortly before it starts until it ends, or this long
 *  after the start when it states no end. */
const PLAN_LEAD_MS = 3 * HOUR_MS;
const PLAN_DEFAULT_LENGTH_MS = 8 * HOUR_MS;
/** One alert per Plan and place in this window, however many reports confirm. */
const ALERT_COOLDOWN_SECONDS = 3 * 60 * 60;

export type BusyStopKind = 'long_line' | 'packed';

/** The first leg that has not started. A leg with no stated start has not. */
export function nextStopItemId(legs: readonly PlanLeg[], now: Date): string | null {
  return legs.find((leg) => !leg.startsAt || leg.startsAt.getTime() > now.getTime())?.itemId ?? null;
}

export function planIsLive(
  plan: { lifecycle: string; startsAt: Date | null; endsAt: Date | null; expiresAt: Date | null; deletedAt: Date | null },
  now: Date,
): boolean {
  if (plan.deletedAt || plan.lifecycle === 'cancelled' || !plan.startsAt) return false;
  if (plan.lifecycle === 'proposed' && plan.expiresAt && now >= plan.expiresAt) return false;
  const end = plan.endsAt?.getTime() ?? plan.startsAt.getTime() + PLAN_DEFAULT_LENGTH_MS;
  return plan.startsAt.getTime() - PLAN_LEAD_MS <= now.getTime() && now.getTime() < end;
}

export function busyStopMessage(kind: BusyStopKind, venueName: string): { title: string; body: string } {
  return kind === 'packed'
    ? { title: 'Your next stop just got packed', body: `Members nearby confirmed ${venueName} is packed right now.` }
    : { title: 'Long line at your next stop', body: `Members nearby confirmed a long line at ${venueName}.` };
}

async function firstAlert(planId: string, venueId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  try {
    return (await redis.set(`map-report-alert:${planId}:${venueId}`, '1', 'EX', ALERT_COOLDOWN_SECONDS, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

/**
 * When a long line or packed report at a venue is confirmed, tells the members
 * going on a live Plan whose next stop is that venue. A stop is that venue
 * when it is a party arriving there or a place item for the same Google place.
 * Members who reported or voted on it already know and are skipped.
 */
export async function alertPlansOfBusyStop(input: {
  venueId: string;
  venueName: string;
  kind: BusyStopKind;
  skipUserIds: readonly string[];
  now: Date;
}): Promise<number> {
  const venue = await db.venue.findUnique({ where: { id: input.venueId }, select: { googlePlaceId: true } });
  if (!venue) return 0;
  const matches = await db.planItem.findMany({
    where: {
      OR: [
        { party: { arrivalVenueId: input.venueId } },
        ...(venue.googlePlaceId ? [{ placeId: venue.googlePlaceId }] : []),
      ],
      plan: { deletedAt: null, lifecycle: { not: 'cancelled' }, startsAt: { not: null, lte: new Date(input.now.getTime() + PLAN_LEAD_MS) } },
    },
    select: { id: true, planId: true },
    take: 200,
  });
  if (matches.length === 0) return 0;
  const matchingItemIds = new Set(matches.map((m) => m.id));

  const plans = await db.plan.findMany({
    where: { id: { in: [...new Set(matches.map((m) => m.planId))] } },
    select: {
      id: true, lifecycle: true, startsAt: true, endsAt: true, expiresAt: true, deletedAt: true,
      items: {
        select: {
          id: true, position: true, createdAt: true, needKind: true, title: true,
          party: { select: { startsAt: true, endsAt: true, lat: true, lng: true, capacity: true } },
          offer: { select: { startsAt: true, durationMins: true, priceCents: true, capacity: true } },
        },
      },
      participants: { where: { status: 'accepted' }, select: { userId: true } },
    },
  });

  const skip = new Set(input.skipUserIds);
  const message = busyStopMessage(input.kind, input.venueName);
  let alerted = 0;
  for (const plan of plans) {
    if (!planIsLive(plan, input.now)) continue;
    const next = nextStopItemId(legsForPlan(plan.items), input.now);
    if (!next || !matchingItemIds.has(next)) continue;
    const userIds = plan.participants.map((p) => p.userId).filter((id) => !skip.has(id));
    if (userIds.length === 0 || !(await firstAlert(plan.id, input.venueId))) continue;
    await deliverPushNotification({
      userIds,
      category: 'reminders',
      title: message.title,
      body: message.body,
      url: `https://bytspot.app/plan/${encodeURIComponent(plan.id)}`,
      type: 'plan-stop-busy',
    });
    alerted++;
  }
  return alerted;
}
