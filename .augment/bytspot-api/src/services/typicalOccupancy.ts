/**
 * Typical occupancy — honest day-part curves.
 *
 * Simulated rows are a catalog of what a place is *usually* like at this
 * hour, not a live sensor. Callers must persist `source: 'typical'` and
 * never label the result Live / Real-time.
 *
 * Live occupancy is reserved for door scans, host-owned parties, and
 * explicit user reports (`bytspot` | `user_report` | `sensor`).
 */

export const TYPICAL_SOURCE = 'typical' as const;

export const LIVE_OCCUPANCY_SOURCES = ['bytspot', 'user_report', 'sensor'] as const;
export type LiveOccupancySource = (typeof LIVE_OCCUPANCY_SOURCES)[number];

export const TYPICAL_LABELS: Record<number, string> = {
  1: 'Chill',
  2: 'Active',
  3: 'Busy',
  4: 'Packed',
};

/** Vibe axes used to pick a day-part curve. Not persisted — catalog only. */
export type OccupancyFingerprint = {
  energy: 'relaxed' | 'energetic';
  social: 'intimate' | 'social';
  style: 'classic' | 'trendy';
  volume: 'quiet' | 'loud';
  density: 'spacious' | 'crowded';
};

export type DayPartCategory =
  | 'coffee'
  | 'golf'
  | 'fitness'
  | 'workspace'
  | 'restaurant'
  | 'bar'
  | 'club'
  | 'park'
  | 'market'
  | 'parking'
  | 'venue';

export type TypicalCrowd = {
  level: number;
  label: string;
  waitMins: number;
  source: typeof TYPICAL_SOURCE;
};

export function isLiveOccupancySource(source: string | null | undefined): boolean {
  return LIVE_OCCUPANCY_SOURCES.includes(source as LiveOccupancySource);
}

export function clampLevel(level: number): number {
  return Math.max(1, Math.min(4, Math.round(level)));
}

/** Normalize venue.category / Discover type onto a day-part curve. */
export function dayPartCategory(raw: string | null | undefined): DayPartCategory {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return 'venue';
  if (/(coffee|cafe|café|espresso)/.test(text)) return 'coffee';
  if (/(golf|links|driving.?range)/.test(text)) return 'golf';
  if (/(fitness|gym|yoga|wellness|training|crossfit)/.test(text)) return 'fitness';
  if (/(workspace|cowork|office|wework|industrious)/.test(text)) return 'workspace';
  if (/(club|nightclub|lounge)/.test(text)) return 'club';
  if (/(bar|pub|tavern)/.test(text)) return 'bar';
  if (/(restaurant|dining|kitchen)/.test(text)) return 'restaurant';
  if (/(park|trail|garden)/.test(text)) return 'park';
  if (/(market|hall|food.?hall)/.test(text)) return 'market';
  if (/(parking|garage|lot)/.test(text)) return 'parking';
  return 'venue';
}

function weekend(dayOfWeek: number): boolean {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function fridaySaturday(dayOfWeek: number): boolean {
  return dayOfWeek === 5 || dayOfWeek === 6;
}

/** Dual-hump helper: peaks at `a` and `b`, quiet in the gaps. */
function dualPeak(hour: number, a: number, b: number, width = 2): number {
  const dist = (peak: number) => {
    let d = Math.abs(hour - peak);
    if (d > 12) d = 24 - d;
    return d;
  };
  const nearest = Math.min(dist(a), dist(b));
  if (nearest <= 1) return 4;
  if (nearest <= width) return 3;
  if (nearest <= width + 2) return 2;
  return 1;
}

function singlePeak(hour: number, peak: number, width = 2): number {
  let dist = Math.abs(hour - peak);
  if (dist > 12) dist = 24 - dist;
  if (dist <= 1) return 4;
  if (dist <= width) return 3;
  if (dist <= width + 2) return 2;
  return 1;
}

/**
 * Typical level for an Atlanta (ET) hour / weekday.
 * Unknown categories get a gentle midday hum — never a 10pm nightlife default.
 */
export function typicalLevel(hour: number, dayOfWeek: number, category: string): number {
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  const d = ((Math.trunc(dayOfWeek) % 7) + 7) % 7;
  const kind = dayPartCategory(category);

  // Shared overnight floor. Golf / park / workspace stay dead later.
  if (h >= 2 && h <= 5) return 1;

  let base: number;
  switch (kind) {
    case 'coffee':
      base = dualPeak(h, 8, 14, 2);
      if (h >= 19) base = 1;
      if (weekend(d) && h < 10) base = Math.max(1, base - 1);
      break;
    case 'golf':
      base = weekend(d) ? singlePeak(h, 10, 3) : dualPeak(h, 8, 16, 2);
      if (h >= 20 || h < 6) base = 1;
      break;
    case 'fitness':
      base = dualPeak(h, 7, 18, 2);
      if (h >= 22 || h < 5) base = 1;
      if (d === 0 && h > 12) base = Math.max(1, base - 1);
      break;
    case 'workspace':
      if (weekend(d)) {
        base = h >= 10 && h <= 16 ? 2 : 1;
      } else {
        base = dualPeak(h, 10, 15, 2);
        if (h < 7 || h >= 20) base = 1;
      }
      break;
    case 'restaurant':
      base = dualPeak(h, 12, 19, 2);
      if (h >= 23 || h < 7) base = 1;
      break;
    case 'bar':
      base = singlePeak(h, 22, 3);
      if (h >= 6 && h < 16) base = 1;
      if (fridaySaturday(d) && h >= 17) base = Math.min(4, base + 1);
      break;
    case 'club':
      base = singlePeak(h, 23, 2);
      if (h >= 6 && h < 20) base = 1;
      if (fridaySaturday(d) && h >= 21) base = Math.min(4, base + 1);
      break;
    case 'park':
      base = singlePeak(h, 14, 4);
      if (h < 7 || h >= 21) base = 1;
      if (weekend(d) && h >= 10 && h <= 16) base = Math.min(4, base + 1);
      break;
    case 'market':
      base = singlePeak(h, 12, 3);
      if (h < 8 || h >= 21) base = 1;
      break;
    case 'parking':
      base = dualPeak(h, 12, 19, 3);
      if (h >= 1 && h <= 6) base = 1;
      break;
    default:
      // Gentle midday — do not dress an unknown pin for Friday night.
      base = h >= 10 && h <= 16 ? 2 : 1;
      if (h >= 11 && h <= 13) base = 3;
      break;
  }

  return clampLevel(base);
}

export function typicalWaitMins(level: number): number {
  if (level <= 1) return 0;
  if (level === 2) return 5;
  if (level === 3) return 12;
  return 20;
}

export function typicalCrowd(hour: number, dayOfWeek: number, category: string): TypicalCrowd {
  const level = typicalLevel(hour, dayOfWeek, category);
  return {
    level,
    label: TYPICAL_LABELS[level],
    waitMins: typicalWaitMins(level),
    source: TYPICAL_SOURCE,
  };
}

/** Deterministic ±0/1 wobble so adjacent venues are not identical. */
export function typicalJitter(level: number, salt: string, hour: number, dayOfWeek: number): number {
  let hash = 0;
  const key = `${salt}:${hour}:${dayOfWeek}`;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 33 + key.charCodeAt(i)) >>> 0;
  const bucket = hash % 10;
  if (bucket === 0) return clampLevel(level - 1);
  if (bucket === 9) return clampLevel(level + 1);
  return clampLevel(level);
}

export type DayPartSeedVenue = {
  name: string;
  slug: string;
  address: string;
  lat: number;
  lng: number;
  category: DayPartCategory;
  fingerprint: OccupancyFingerprint;
};

/** Midtown Atlanta day-part inventory — arrival hours, not just Friday night. */
export const MIDTOWN_DAY_PART_VENUES: DayPartSeedVenue[] = [
  {
    name: 'Dancing Goats Coffee — Midtown',
    slug: 'dancing-goats-midtown',
    address: '650 North Ave NE',
    lat: 33.7716,
    lng: -84.3848,
    category: 'coffee',
    fingerprint: { energy: 'relaxed', social: 'social', style: 'trendy', volume: 'quiet', density: 'crowded' },
  },
  {
    name: 'Octane Coffee — Midtown',
    slug: 'octane-coffee-midtown',
    address: '1009-B Marietta St NW',
    lat: 33.7796,
    lng: -84.4102,
    category: 'coffee',
    fingerprint: { energy: 'energetic', social: 'social', style: 'trendy', volume: 'loud', density: 'crowded' },
  },
  {
    name: 'Bobby Jones Golf Course',
    slug: 'bobby-jones-golf-course',
    address: '384 Woodward Way NW',
    lat: 33.8115,
    lng: -84.4055,
    category: 'golf',
    fingerprint: { energy: 'relaxed', social: 'intimate', style: 'classic', volume: 'quiet', density: 'spacious' },
  },
  {
    name: 'Sweat440 Midtown',
    slug: 'sweat440-midtown',
    address: '999 Peachtree St NE',
    lat: 33.7812,
    lng: -84.3841,
    category: 'fitness',
    fingerprint: { energy: 'energetic', social: 'social', style: 'trendy', volume: 'loud', density: 'crowded' },
  },
  {
    name: 'Industrious Midtown',
    slug: 'industrious-midtown',
    address: '1175 Peachtree St NE',
    lat: 33.7865,
    lng: -84.3833,
    category: 'workspace',
    fingerprint: { energy: 'relaxed', social: 'intimate', style: 'classic', volume: 'quiet', density: 'spacious' },
  },
];
