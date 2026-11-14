import { distanceMeters } from './recommendations';
import { LAUNCH_MARKET } from '../bytt-si/suggestions/area';
import { timezoneAt } from '../vendor/geocode';

export const LAUNCH_TIME_ZONE = 'America/New_York';
/** Around the launch market the zone is known without a lookup. */
const LAUNCH_ZONE_METERS = 80_000;
export const AREA_TIME_ZONE_TIMEOUT_MS = 1000;
const CACHE_MAX = 500;
const cache = new Map<string, string>();

type Lookup = (lat: number, lng: number) => Promise<string | undefined>;

/**
 * The IANA zone a Plan's area keeps, so "Saturday 8pm in LA" means 8pm in LA.
 * Near Atlanta it is America/New_York; elsewhere Google is asked once per
 * ~10 km cell. Null when there is no point or the lookup fails: callers fall
 * back to the launch market or the device, never a guess.
 */
export async function areaTimeZone(
  point: { lat: number | null; lng: number | null } | null,
  lookup: Lookup = timezoneAt,
): Promise<string | null> {
  if (!point || point.lat === null || point.lng === null || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
  const at = { lat: point.lat, lng: point.lng };
  if (distanceMeters(at, LAUNCH_MARKET) <= LAUNCH_ZONE_METERS) return LAUNCH_TIME_ZONE;
  const key = `${at.lat.toFixed(1)},${at.lng.toFixed(1)}`;
  const known = cache.get(key);
  if (known) return known;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const zone = await Promise.race([
      lookup(at.lat, at.lng),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), AREA_TIME_ZONE_TIMEOUT_MS); }),
    ]);
    if (!zone) return null;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, zone);
    return zone;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function clearAreaTimeZoneCache(): void {
  cache.clear();
}
