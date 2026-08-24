import { db } from '../lib/db';
import { config } from '../config';
import { getRedis } from '../lib/redis';
import { sendApnsNotification } from './apns';
import {
  getEligibleIosPushDevices,
  invalidateIosPushDevice,
  type PushCategory,
} from './iosPushDevices';

export interface NotificationDeliveryResult {
  targetedUsers: number;
  devices: number;
  sent: number;
  skipped: number;
  permanentFailures: number;
  temporaryFailures: number;
}

export interface PushDeliveryTotals {
  sent: number;
  skipped: number;
  permanentFailures: number;
  temporaryFailures: number;
  lastSentAt: string | null;
}

const TOTALS_KEY = 'push:outcomes';
const localTotals: PushDeliveryTotals = {
  sent: 0, skipped: 0, permanentFailures: 0, temporaryFailures: 0, lastSentAt: null,
};

/**
 * Every outcome here was already computed and then discarded, which is why a
 * provider that signs correctly and is rejected by Apple reads the same as a
 * night with nothing to announce. The tallies are kept so the question "has a
 * push ever been delivered" has an answer that is not an inference.
 */
async function recordPushOutcomes(result: NotificationDeliveryResult): Promise<void> {
  if (result.devices === 0) return;
  const sentAt = result.sent > 0 ? new Date().toISOString() : null;

  const redis = getRedis();
  if (redis) {
    try {
      const pipeline = redis.pipeline();
      pipeline.hincrby(TOTALS_KEY, 'sent', result.sent);
      pipeline.hincrby(TOTALS_KEY, 'skipped', result.skipped);
      pipeline.hincrby(TOTALS_KEY, 'permanentFailures', result.permanentFailures);
      pipeline.hincrby(TOTALS_KEY, 'temporaryFailures', result.temporaryFailures);
      if (sentAt) pipeline.hset(TOTALS_KEY, 'lastSentAt', sentAt);
      await pipeline.exec();
      return;
    } catch {
      // Counters must never break a send; fall through to the local tally.
    }
  }

  localTotals.sent += result.sent;
  localTotals.skipped += result.skipped;
  localTotals.permanentFailures += result.permanentFailures;
  localTotals.temporaryFailures += result.temporaryFailures;
  if (sentAt) localTotals.lastSentAt = sentAt;
}

/** Totals are observability only, so an unreadable store reports zeros rather than throwing. */
export async function readPushDeliveryTotals(): Promise<PushDeliveryTotals> {
  const redis = getRedis();
  if (!redis) return { ...localTotals };
  try {
    const stored = await redis.hgetall(TOTALS_KEY);
    const count = (field: string) => Number(stored?.[field] ?? 0) || 0;
    return {
      sent: count('sent'),
      skipped: count('skipped'),
      permanentFailures: count('permanentFailures'),
      temporaryFailures: count('temporaryFailures'),
      lastSentAt: stored?.lastSentAt ?? null,
    };
  } catch {
    return { ...localTotals };
  }
}

export function resetPushDeliveryTotalsForTests(): void {
  localTotals.sent = 0;
  localTotals.skipped = 0;
  localTotals.permanentFailures = 0;
  localTotals.temporaryFailures = 0;
  localTotals.lastSentAt = null;
}

export function isAllowedBytspotUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'bytspot.app'
      && url.port === ''
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

export function venueNotificationUrl(slug: string | null | undefined): string {
  return slug ? `https://bytspot.app/venue/${encodeURIComponent(slug)}` : 'https://bytspot.app/discover';
}

export async function deliverPushNotification(input: {
  userIds: string[];
  category: PushCategory;
  title: string;
  body: string;
  url: string;
  type: string;
}): Promise<NotificationDeliveryResult> {
  const targetUserIds = [...new Set(input.userIds)];
  const empty = {
    targetedUsers: targetUserIds.length,
    devices: 0,
    sent: 0,
    skipped: 0,
    permanentFailures: 0,
    temporaryFailures: 0,
  };
  if (targetUserIds.length === 0 || !isAllowedBytspotUrl(input.url)) return empty;

  try {
    const devices = await getEligibleIosPushDevices(targetUserIds, input.category, config.apnsBundleId);
    const outcomes = await Promise.all(devices.map(async (device) => {
      try {
        const status = await sendApnsNotification(device, {
          aps: { alert: { title: input.title, body: input.body }, sound: 'default' },
          url: input.url,
          type: input.type,
        });
        if (status === 'permanent-failure') {
          await invalidateIosPushDevice(device.token).catch(() => {});
        }
        return status;
      } catch {
        return 'temporary-failure' as const;
      }
    }));

    const result = outcomes.reduce<NotificationDeliveryResult>((tally, status) => {
      tally.devices++;
      if (status === 'sent') tally.sent++;
      else if (status === 'skipped') tally.skipped++;
      else if (status === 'permanent-failure') tally.permanentFailures++;
      else tally.temporaryFailures++;
      return tally;
    }, empty);
    await recordPushOutcomes(result);
    return result;
  } catch {
    // Notifications are best-effort and must never break the triggering flow.
    return { ...empty, temporaryFailures: 1 };
  }
}

export async function sendVenueCrowdAlert(input: {
  venueId: string;
  venueName: string;
  venueSlug: string | null | undefined;
  title: string;
  body: string;
  type: 'packed' | 'opened-up';
}): Promise<NotificationDeliveryResult> {
  try {
    const savedSpots = await db.savedSpot.findMany({
      where: { venueId: input.venueId },
      select: { userId: true },
    });
    return deliverPushNotification({
      userIds: savedSpots.map((savedSpot) => savedSpot.userId),
      category: 'nearby',
      title: input.title,
      body: input.body,
      url: venueNotificationUrl(input.venueSlug),
      type: input.type,
    });
  } catch {
    return {
      targetedUsers: 0,
      devices: 0,
      sent: 0,
      skipped: 0,
      permanentFailures: 0,
      temporaryFailures: 1,
    };
  }
}
