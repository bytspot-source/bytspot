import { db } from '../lib/db';

export type IosPushEnvironment = 'production' | 'sandbox';
export type PushCategory = 'reservations' | 'promotions' | 'reminders' | 'insider' | 'nearby';

export const DEFAULT_PUSH_PREFERENCES: Record<PushCategory, boolean> = {
  reservations: true,
  promotions: true,
  reminders: true,
  insider: true,
  nearby: false,
};

/** APNs tokens are exactly 32 bytes represented as 64 hexadecimal characters. */
export function normalizeIosDeviceToken(token: string): string | null {
  const normalized = token.toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

export async function registerIosPushDevice(input: {
  userId: string;
  token: string;
  environment: IosPushEnvironment;
  bundleId: string;
}): Promise<void> {
  const now = new Date();
  await db.iOSPushDevice.upsert({
    where: { token: input.token },
    create: {
      token: input.token,
      userId: input.userId,
      environment: input.environment,
      bundleId: input.bundleId,
      lastSeenAt: now,
    },
    // The unique token is deliberately reassigned when its authenticated owner
    // registers it. This prevents a stale account from receiving pushes after
    // account switching on the same device.
    update: {
      userId: input.userId,
      environment: input.environment,
      bundleId: input.bundleId,
      lastSeenAt: now,
      invalidatedAt: null,
    },
  });
}

export async function unregisterIosPushDevice(userId: string, token: string): Promise<boolean> {
  const result = await db.iOSPushDevice.updateMany({
    where: { token, userId, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
  return result.count > 0;
}

export async function invalidateIosPushDevice(token: string): Promise<void> {
  await db.iOSPushDevice.updateMany({
    where: { token, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
}

function permitsCategory(rawPreferences: unknown, category: PushCategory): boolean {
  if (!rawPreferences || typeof rawPreferences !== 'object' || Array.isArray(rawPreferences)) {
    return DEFAULT_PUSH_PREFERENCES[category];
  }

  const push = (rawPreferences as { push?: unknown }).push;
  if (!push || typeof push !== 'object' || Array.isArray(push)) {
    return DEFAULT_PUSH_PREFERENCES[category];
  }

  const value = (push as Record<string, unknown>)[category];
  return typeof value === 'boolean' ? value : DEFAULT_PUSH_PREFERENCES[category];
}

export interface EligibleIosPushDevice {
  token: string;
  environment: IosPushEnvironment;
}

export async function getEligibleIosPushDevices(
  userIds: string[],
  category: PushCategory,
  bundleId: string,
): Promise<EligibleIosPushDevice[]> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return [];

  const devices = await db.iOSPushDevice.findMany({
    where: {
      userId: { in: uniqueUserIds },
      bundleId,
      invalidatedAt: null,
    },
    select: {
      token: true,
      environment: true,
      user: { select: { notificationPrefs: true } },
    },
  });

  return devices
    .filter((device) => permitsCategory(device.user.notificationPrefs, category))
    .map((device) => ({
      token: device.token,
      environment: device.environment as IosPushEnvironment,
    }));
}
