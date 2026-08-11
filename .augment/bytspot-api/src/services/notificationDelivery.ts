import { db } from '../lib/db';
import { config } from '../config';
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

    return outcomes.reduce<NotificationDeliveryResult>((result, status) => {
      result.devices++;
      if (status === 'sent') result.sent++;
      else if (status === 'skipped') result.skipped++;
      else if (status === 'permanent-failure') result.permanentFailures++;
      else result.temporaryFailures++;
      return result;
    }, empty);
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
