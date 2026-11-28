/**
 * Vibe-match pushes. One new place or public Host Studio party that fits a
 * member's saved vibes, for people who turned the category on.
 *
 * Matching rule
 * -------------
 * There is no Post model. A candidate is either:
 *   - a discoverable, walk-in venue whose `createdAt` falls in the window, or
 *   - a Host Studio party whose `publishedAt` falls in the window (a draft is
 *     not new to anyone until it is published).
 *
 * The window is everything since the previous run, and never more than seven
 * days. The cursor is `push:vibe-matches:watermark`. A missing cursor, or a
 * run with no Redis, uses that seven-day floor. NotificationSend still
 * refuses a second send of the same item, so a lost cursor cannot repeat one.
 * The cursor is global: someone who opts in later hears about what is
 * published after that, not a backlog. Quiet hours do not move the cursor,
 * so something published overnight is still new in the morning.
 *
 * A party is a candidate only when `filterDiscoverableParties` would show it
 * to a stranger: published, open door (`free-rsvp` or `paid-ticket`), public
 * location, not a private template, not ended, not paused, not closed, share
 * link still good. Circle-only rooms, approval doors, cancelled parties,
 * parties hidden by reports, and parties hosted by a suspended account are
 * not candidates. This job does not load circle membership, so it cannot
 * decide who may see a circle room, and a lock screen is not an invitation.
 * The host is not told about their own party. A member who blocked that host,
 * or who does not meet `requiredMembershipTier`, is skipped for that party.
 *
 * Tags:
 *   - Venue: the words of `category` (hyphens and underscores are spaces).
 *   - Party: `hostType` and `hostCategory` only when `hostDiscoveryTags`
 *     accepts the pair, the bookable category from `categoryForParty` for
 *     that pair (so an empty config does not become "events"), and music
 *     genres that are short tokens. Titles, taglines, and venue names are
 *     not tags.
 *
 * A saved vibe matches when one of those tags equals the vibe, equals it
 * plus "s", or — for a word of four letters or more — ends with it. So
 * "nightclub" matches "club", and "barrel" does not match "bar". A vibe that
 * names a recommendations profile (`knownVibe`, including date_night → date)
 * also matches when a tag hits one of that profile's category words.
 * "nightclub" and "nightclubs" are read as the drinks profile. An unknown
 * word does not fall through to the time-of-day mix `vibeProfile` uses for
 * ranking. A push requires a real tag hit.
 *
 * Avoid tags from `preferenceFit` drop a candidate whose category text hits
 * them. Price is not applied: venue and party rows have no Google price level
 * for that filter to read.
 *
 * The member's vibes are tried in saved order. The copy names the first one
 * that matched. Of the remaining items, the newest is the one we send.
 *
 * Copy
 * ----
 * Informational. No scarcity, no capacity, no street address. The area is
 * Midtown or Atlanta only when the coordinates say so. Busyness comes from
 * the typical day-part curve and says "Typically", unless a live reading
 * (`bytspot`, `user_report`, or `sensor`) is at most 30 minutes old, in
 * which case the line is that label and "right now". A `typical` row is
 * never treated as live. An unknown category gets no busyness line.
 *
 * Caps, proposed: one send per member per America/New_York calendar day,
 * three per rolling seven days. Quiet hours, proposed because none are
 * stored on the member: no sends from 10:00 PM until 9:00 AM America/New_York.
 */

import type { Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { getRedis } from '../lib/redis';
import { meetsRequiredMembershipTier } from '../lib/membershipTier';
import { classifyArea } from '../bytt-si/suggestions/area';
import { categoryForParty } from '../trpc/planRouter';
import { claimNotificationSend, partyUrl } from './scheduledPushes';
import { deliverPushNotification, isAllowedBytspotUrl, venueNotificationUrl } from './notificationDelivery';
import { permitsCategory } from './iosPushDevices';
import { knownVibe } from './recommendations';
import { hostDiscoveryTags } from './hostTaxonomy';
import { dayPartForNeed, filterDiscoverableParties, discoverablePartyWhere, type DiscoverablePartyFacts } from './primePathCandidates';
import { matchedAvoidTag, normalizePreferences } from './preferenceFit';
import { LIVE_CROWD_FRESH_MS } from './latestCrowd';
import {
  TYPICAL_LABELS,
  clampLevel,
  dayPartCategory,
  isLiveOccupancySource,
  typicalLevel,
} from './typicalOccupancy';

/** Proposed: one vibe push per member per New York calendar day. */
export const VIBE_MAX_SENDS_PER_DAY = 1;
/** Proposed: three vibe pushes per member per rolling seven days. */
export const VIBE_MAX_SENDS_PER_WEEK = 3;
/** A first run, or a cursor older than this, does not walk the whole catalog. */
export const VIBE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const VIBE_QUIET_TIME_ZONE = 'America/New_York';
/** Quiet from this hour inclusive… */
export const VIBE_QUIET_START_HOUR = 22;
/** …until this hour exclusive. 9:00 AM is a sending hour. */
export const VIBE_QUIET_END_HOUR = 9;
export const VIBE_DEDUPE_PREFIX = 'vibe.match:';

const WATERMARK_KEY = 'push:vibe-matches:watermark';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 100;
const MEMBER_LIMIT = 2000;
const CROWD_WORDS = new Set(['chill', 'active', 'busy', 'packed']);

/** Closed forms of a profile that onboarding may store as their own word. */
const PUSH_VIBE_ALIASES: Record<string, string> = {
  nightclub: 'nightlife',
  nightclubs: 'nightlife',
};

export interface VibeWatermarkStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface VibeMatchJobResult {
  quiet: boolean;
  since: string | null;
  candidates: number;
  sent: number;
  skippedOptOut: number;
  skippedNoDevice: number;
  skippedNoMatch: number;
  skippedDuplicate: number;
  skippedCaps: number;
}

type VibeDeliver = (input: Parameters<typeof deliverPushNotification>[0]) => Promise<unknown>;

export interface VibeMatchOptions {
  /** When set, the run uses this window and does not move the cursor. */
  since?: Date;
  /** Null skips Redis. Omit it and the job uses the process Redis, if any. */
  redis?: VibeWatermarkStore | null;
  deliver?: VibeDeliver;
}

export interface VibeLiveReading {
  level: number;
  label?: string | null;
  source: string;
  recordedAt: Date;
}

interface Candidate {
  kind: 'venue' | 'party';
  id: string;
  name: string;
  slug: string | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  categoryText: string;
  crowdCategory: string | null;
  at: Date;
  live: VibeLiveReading | null;
  hostUserId: string | null;
  requiredMembershipTier: string | null;
}

interface MemberRow {
  id: string;
  deletedAt?: Date | null;
  membershipTier?: string | null;
  notificationPrefs: unknown;
  preference: { vibes: string[]; avoid?: string[] | null } | null;
  iosPushDevices: { id?: string; invalidatedAt?: Date | null }[];
}

const emptyResult = (quiet: boolean, since: string | null): VibeMatchJobResult => ({
  quiet,
  since,
  candidates: 0,
  sent: 0,
  skippedOptOut: 0,
  skippedNoDevice: 0,
  skippedNoMatch: 0,
  skippedDuplicate: 0,
  skippedCaps: 0,
});

export function vibeDedupeKey(kind: 'venue' | 'party', id: string): string {
  return `${VIBE_DEDUPE_PREFIX}${kind}:${id}`;
}

export function normalizeVibeToken(vibe: string): string {
  return vibe.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The category phrase, plus each word. Hyphens are spaces, so food-drink is food and drink. */
export function tagsFromText(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const words = normalized.split(' ').filter(Boolean);
  return [...new Set([normalized, ...words])];
}

export function venueVibeTags(category: string | null | undefined): string[] {
  return tagsFromText(category ?? '');
}

function genreTags(genres: unknown): string[] {
  if (!Array.isArray(genres)) return [];
  return genres.flatMap((genre) => {
    if (typeof genre !== 'string') return [];
    const token = genre.trim().toLowerCase();
    if (!/^[a-z0-9]+(?:[ -][a-z0-9]+){0,3}$/.test(token)) return [];
    return tagsFromText(token);
  });
}

/** Tags a party is allowed to be matched on. Unvalidated template JSON contributes nothing. */
export function partyVibeTags(input: { templateConfig: unknown; musicGenres?: readonly string[] | null }): string[] {
  const discovered = hostDiscoveryTags(input.templateConfig);
  const bits: string[] = [];
  if (discovered.hostType) bits.push(discovered.hostType);
  if (discovered.hostCategory) bits.push(discovered.hostCategory);
  if (discovered.hostType) bits.push(categoryForParty(input.templateConfig as Prisma.JsonValue));
  bits.push(...genreTags(input.musicGenres));
  return [...new Set(bits.flatMap((bit) => tagsFromText(bit)))];
}

/** Equal, a simple plural, or a longer word that ends in a needle of 4+ letters. */
export function tagHits(tag: string, needle: string): boolean {
  if (!tag || !needle) return false;
  if (tag === needle || tag === `${needle}s`) return true;
  if (needle.length < 4 || tag.length <= needle.length) return false;
  return tag.endsWith(needle);
}

export function itemMatchesVibe(item: { tags: readonly string[] }, vibe: string): boolean {
  const token = normalizeVibeToken(vibe);
  if (!token) return false;
  if (item.tags.some((tag) => tagHits(tag, token))) return true;
  const known = knownVibe(PUSH_VIBE_ALIASES[token] ?? token);
  if (!known) return false;
  return known.categories.some((word) => item.tags.some((tag) => tagHits(tag, word)));
}

/** True when the category text hits a saved avoid tag. Price is not readable here. */
export function itemHitsAvoid(categoryText: string, avoid: readonly string[] | null | undefined): boolean {
  const prefs = normalizePreferences({ avoid: avoid ?? [] });
  return matchedAvoidTag({ category: categoryText }, prefs.avoid) !== null;
}

/**
 * Which day-part curve this text may quote. A meal word uses the restaurant
 * curve. Anything `dayPartCategory` would call a generic venue gets no line,
 * so we do not invent a midday hum.
 */
export function crowdCurveFor(text: string | null | undefined): string | null {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (/\b(brunch|breakfast|lunch|dinner)\b/.test(raw)) return 'restaurant';
  const fromNeed = dayPartForNeed(raw);
  if (fromNeed) return fromNeed;
  const kind = dayPartCategory(raw);
  if (kind === 'venue' || kind === 'parking') return null;
  return kind;
}

interface NewYorkClock {
  hour: number;
  weekday: number;
  dayStart: Date;
}

function newYorkClock(now: Date): NewYorkClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: VIBE_QUIET_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: VIBE_QUIET_TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const offset = zone.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '-05:00';
  return {
    hour,
    weekday,
    dayStart: new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00${offset}`),
  };
}

/** 10:00 PM inclusive through 9:00 AM exclusive, America/New_York. */
export function isVibeQuietHours(now: Date): boolean {
  const { hour } = newYorkClock(now);
  return hour >= VIBE_QUIET_START_HOUR || hour < VIBE_QUIET_END_HOUR;
}

function formatHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

function crowdWord(level: number, label?: string | null): string {
  const cleaned = (label ?? '').trim().toLowerCase();
  if (CROWD_WORDS.has(cleaned)) return cleaned;
  return (TYPICAL_LABELS[clampLevel(level)] ?? 'Active').toLowerCase();
}

function typicalLine(now: Date, curve: string): string | null {
  const clock = newYorkClock(now);
  let hour = clock.hour;
  let weekday = clock.weekday;
  const samples: { hour: number; level: number }[] = [];
  for (let i = 0; i < 16; i += 1) {
    samples.push({ hour, level: typicalLevel(hour, weekday, curve) });
    hour += 1;
    if (hour === 24) {
      hour = 0;
      weekday = (weekday + 1) % 7;
    }
  }
  const nowLevel = samples[0]?.level;
  if (nowLevel === undefined) return null;
  const label = crowdWord(nowLevel);
  const change = samples.findIndex((sample, index) => index > 0 && sample.level !== nowLevel);
  if (change < 0) return `Typically ${label} for the next several hours.`;
  const next = samples[change];
  if (next.level > nowLevel) return `Typically ${label} before ${formatHourLabel(next.hour)}.`;
  return `Typically ${crowdWord(next.level)} after ${formatHourLabel(next.hour)}.`;
}

/** Live when the reading is a live source and at most 30 minutes old. Otherwise the typical curve, or nothing. */
export function vibeBusynessLine(now: Date, category: string | null, live: VibeLiveReading | null | undefined): string | null {
  if (live && isLiveOccupancySource(live.source)) {
    const at = new Date(live.recordedAt);
    const age = now.getTime() - at.getTime();
    if (!Number.isNaN(at.getTime()) && age >= 0 && age <= LIVE_CROWD_FRESH_MS) {
      const word = crowdWord(live.level, live.label);
      return `${word.charAt(0).toUpperCase()}${word.slice(1)} right now.`;
    }
  }
  const curve = crowdCurveFor(category);
  return curve ? typicalLine(now, curve) : null;
}

function areaName(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const area = classifyArea({ lat, lng });
  if (area.basis !== 'coordinates' || !area.label) return null;
  return area.label;
}

function clipName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= 80) return clean;
  return `${clean.slice(0, 79).trimEnd()}…`;
}

export function vibePushCopy(input: {
  kind: 'venue' | 'party';
  id: string;
  name: string;
  slug: string | null;
  lat: number | null;
  lng: number | null;
  vibe: string;
  crowdCategory: string | null;
  live: VibeLiveReading | null;
}, now: Date): { title: string; body: string; url: string } | null {
  const label = normalizeVibeToken(input.vibe);
  const name = clipName(input.name);
  if (!label || !name) return null;
  const url = input.kind === 'venue'
    ? (input.slug ? venueNotificationUrl(input.slug) : '')
    : partyUrl(input.id);
  if (!url || !isAllowedBytspotUrl(url)) return null;
  if (input.kind === 'venue' && !url.includes('/venue/')) return null;
  const where = areaName(input.lat, input.lng);
  const busy = vibeBusynessLine(now, input.crowdCategory, input.live);
  const place = where ? `${name} in ${where}` : name;
  return {
    title: `New for your ${label} vibe`,
    body: busy ? `${place}. ${busy}` : `${place}.`,
    url,
  };
}

function inWindow(at: Date | null | undefined, since: Date, now: Date): boolean {
  if (!at) return false;
  const t = new Date(at).getTime();
  return !Number.isNaN(t) && t > since.getTime() && t <= now.getTime();
}

function clampSince(since: Date, now: Date): Date {
  const floor = now.getTime() - VIBE_LOOKBACK_MS;
  const t = since.getTime();
  if (Number.isNaN(t)) return new Date(floor);
  return new Date(Math.min(now.getTime(), Math.max(floor, t)));
}

async function readSince(now: Date, redis: VibeWatermarkStore | null): Promise<Date> {
  const floor = new Date(now.getTime() - VIBE_LOOKBACK_MS);
  if (!redis) return floor;
  try {
    const raw = await redis.get(WATERMARK_KEY);
    if (!raw) return floor;
    return clampSince(new Date(raw), now);
  } catch {
    return floor;
  }
}

async function writeSince(now: Date, redis: VibeWatermarkStore | null): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(WATERMARK_KEY, now.toISOString());
  } catch {
    // The next run rescans the lookback. NotificationSend still blocks a repeat.
  }
}

interface PartyRow {
  id: string;
  title: string;
  hostUserId: string;
  templateId: string;
  templateConfig: Prisma.JsonValue;
  musicGenres: string[];
  status: string;
  admissionPaused: boolean;
  closedAt: Date | null;
  cancelledAt: Date | null;
  endsAt: Date | null;
  startsAt: Date;
  accessMode: string;
  requiredMembershipTier: string;
  audienceCircleIds: string[];
  locationDisclosure: string;
  shareLinkExpiresAt: Date | null;
  showOnDiscover: boolean;
  publishedAt: Date | null;
  lat: number | null;
  lng: number | null;
  moderationHiddenAt: Date | null;
  capacity: number;
  venueName?: string | null;
  host?: { suspendedAt: Date | null } | null;
}

/** Public, still going, and published inside the window. Circle rooms never qualify. */
export function isAnnounceableParty(party: PartyRow, now: Date): boolean {
  if (!party.publishedAt || party.cancelledAt || party.moderationHiddenAt) return false;
  if (party.host?.suspendedAt) return false;
  if (party.audienceCircleIds.length > 0) return false;
  if (!party.startsAt) return false;
  const facts: DiscoverablePartyFacts = {
    id: party.id,
    title: party.title,
    capacity: party.capacity,
    status: party.status,
    admissionPaused: party.admissionPaused,
    closedAt: party.closedAt,
    endsAt: party.endsAt,
    startsAt: party.startsAt,
    accessMode: party.accessMode,
    requiredMembershipTier: party.requiredMembershipTier,
    audienceCircleIds: party.audienceCircleIds,
    latitude: party.lat,
    longitude: party.lng,
    templateId: party.templateId,
    locationDisclosure: party.locationDisclosure,
    shareLinkExpiresAt: party.shareLinkExpiresAt,
    showOnDiscover: party.showOnDiscover,
  };
  // Black clears every real tier. The member's own tier is checked later.
  return filterDiscoverableParties([facts], {
    userTier: 'black',
    userCircleIds: new Set<string>(),
    attachedPartyIds: new Set<string>(),
    now,
  }).length === 1;
}

function blocksByUser(rows: { blockerId: string; blockedId: string }[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    const set = map.get(from) ?? new Set<string>();
    set.add(to);
    map.set(from, set);
  };
  for (const row of rows) {
    add(row.blockerId, row.blockedId);
    add(row.blockedId, row.blockerId);
  }
  return map;
}

function liveReading(row: { level: number; label: string | null; source: string; recordedAt: Date }, now: Date): VibeLiveReading | null {
  if (!isLiveOccupancySource(row.source)) return null;
  const at = new Date(row.recordedAt);
  const age = now.getTime() - at.getTime();
  if (Number.isNaN(at.getTime()) || age < 0 || age > LIVE_CROWD_FRESH_MS) return null;
  return { level: row.level, label: row.label, source: row.source, recordedAt: at };
}

export async function sendVibeMatches(now: Date = new Date(), options: VibeMatchOptions = {}): Promise<VibeMatchJobResult> {
  if (isVibeQuietHours(now)) return emptyResult(true, null);

  const redis = options.redis === undefined ? getRedis() : options.redis;
  const since = options.since ? clampSince(options.since, now) : await readSince(now, redis);
  const deliver = options.deliver ?? deliverPushNotification;
  const ownsCursor = options.since === undefined;

  const [venueRows, partyRows] = await Promise.all([
    db.venue.findMany({
      where: {
        discoverable: true,
        onlineOnly: false,
        createdAt: { gt: since, lte: now },
      },
      select: { id: true, name: true, slug: true, category: true, lat: true, lng: true, createdAt: true, discoverable: true, onlineOnly: true },
      orderBy: { createdAt: 'desc' },
      take: CANDIDATE_LIMIT,
    }),
    db.party.findMany({
      where: {
        ...discoverablePartyWhere(now),
        audienceCircleIds: { isEmpty: true },
        cancelledAt: null,
        publishedAt: { gt: since, lte: now },
      },
      select: {
        id: true, title: true, hostUserId: true, templateId: true, templateConfig: true, musicGenres: true,
        status: true, admissionPaused: true, closedAt: true, cancelledAt: true, endsAt: true, startsAt: true,
        accessMode: true, requiredMembershipTier: true, audienceCircleIds: true, locationDisclosure: true,
        shareLinkExpiresAt: true, showOnDiscover: true, publishedAt: true, lat: true, lng: true,
        moderationHiddenAt: true, capacity: true,
        host: { select: { suspendedAt: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take: CANDIDATE_LIMIT,
    }),
  ]);

  const freshVenues = venueRows.filter((venue) => (
    venue.discoverable === true
    && venue.onlineOnly === false
    && Boolean(venue.slug)
    && Boolean(venue.name.trim())
    && inWindow(venue.createdAt, since, now)
  ));
  const venueIds = freshVenues.map((venue) => venue.id);
  const crowdRows = venueIds.length === 0 ? [] : await db.crowdLevel.findMany({
    where: {
      venueId: { in: venueIds },
      recordedAt: { gte: new Date(now.getTime() - LIVE_CROWD_FRESH_MS) },
      source: { in: ['bytspot', 'user_report', 'sensor'] },
    },
    orderBy: { recordedAt: 'desc' },
    take: CANDIDATE_LIMIT * 2,
  });
  const liveByVenue = new Map<string, VibeLiveReading>();
  for (const row of crowdRows) {
    if (liveByVenue.has(row.venueId)) continue;
    const live = liveReading(row, now);
    if (live) liveByVenue.set(row.venueId, live);
  }

  const candidates: Candidate[] = [
    ...freshVenues.map((venue) => {
      const tags = venueVibeTags(venue.category);
      return {
        kind: 'venue' as const,
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        lat: venue.lat,
        lng: venue.lng,
        tags,
        categoryText: venue.category,
        crowdCategory: crowdCurveFor(venue.category),
        at: venue.createdAt,
        live: liveByVenue.get(venue.id) ?? null,
        hostUserId: null,
        requiredMembershipTier: null,
      };
    }),
    ...partyRows.flatMap((party) => {
      const row = party as PartyRow;
      if (!isAnnounceableParty(row, now) || !inWindow(row.publishedAt, since, now)) return [];
      const tags = partyVibeTags(row);
      if (tags.length === 0 || !row.title.trim()) return [];
      const categoryText = tags.join(' ');
      return [{
        kind: 'party' as const,
        id: row.id,
        name: row.title,
        slug: null,
        lat: row.lat,
        lng: row.lng,
        tags,
        categoryText,
        crowdCategory: crowdCurveFor(categoryText),
        at: row.publishedAt!,
        live: null,
        hostUserId: row.hostUserId,
        requiredMembershipTier: row.requiredMembershipTier,
      }];
    }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));

  const result = emptyResult(false, since.toISOString());
  result.candidates = candidates.length;

  const members = candidates.length === 0 ? [] : await db.user.findMany({
    where: { deletedAt: null, preference: { is: { vibes: { isEmpty: false } } } },
    select: {
      id: true,
      membershipTier: true,
      notificationPrefs: true,
      preference: { select: { vibes: true, avoid: true } },
      iosPushDevices: { where: { invalidatedAt: null }, select: { id: true }, take: 1 },
    },
    orderBy: { id: 'asc' },
    take: MEMBER_LIMIT,
  }) as MemberRow[];

  const partyHosts = [...new Set(candidates.flatMap((item) => item.hostUserId ? [item.hostUserId] : []))];
  const memberIds = members.map((member) => member.id);
  const blockRows = partyHosts.length === 0 || memberIds.length === 0 ? [] : await db.userBlock.findMany({
    where: { OR: [{ blockerId: { in: memberIds } }, { blockedId: { in: partyHosts } }] },
    select: { blockerId: true, blockedId: true },
  });
  const blocked = blocksByUser(blockRows);

  const ready: { member: MemberRow; options: { item: Candidate; copy: { title: string; body: string; url: string } }[] }[] = [];
  for (const member of members) {
    if (member.deletedAt) continue;
    const vibes = (member.preference?.vibes ?? []).map(normalizeVibeToken).filter(Boolean);
    if (vibes.length === 0) continue;
    if (!permitsCategory(member.notificationPrefs, 'vibe')) {
      result.skippedOptOut += 1;
      continue;
    }
    const devices = (member.iosPushDevices ?? []).filter((device) => !device.invalidatedAt);
    if (devices.length === 0) {
      result.skippedNoDevice += 1;
      continue;
    }
    const avoid = member.preference?.avoid ?? [];
    const blockedHosts = blocked.get(member.id) ?? new Set<string>();
    const optionsForMember: { item: Candidate; copy: { title: string; body: string; url: string } }[] = [];
    for (const item of candidates) {
      if (item.hostUserId && (item.hostUserId === member.id || blockedHosts.has(item.hostUserId))) continue;
      if (item.requiredMembershipTier && !meetsRequiredMembershipTier(member.membershipTier, item.requiredMembershipTier)) continue;
      if (itemHitsAvoid(item.categoryText, avoid)) continue;
      const vibe = vibes.find((saved) => itemMatchesVibe(item, saved));
      if (!vibe) continue;
      const copy = vibePushCopy({ ...item, vibe }, now);
      if (copy) optionsForMember.push({ item, copy });
    }
    if (optionsForMember.length === 0) {
      result.skippedNoMatch += 1;
      continue;
    }
    ready.push({ member, options: optionsForMember });
  }

  if (ready.length > 0) {
    const weekAgo = new Date(now.getTime() - WEEK_MS);
    const dayStart = newYorkClock(now).dayStart;
    const prior = await db.notificationSend.findMany({
      where: {
        userId: { in: ready.map((row) => row.member.id) },
        dedupeKey: { startsWith: VIBE_DEDUPE_PREFIX },
        sentAt: { gte: weekAgo },
      },
      select: { userId: true, dedupeKey: true, sentAt: true },
    });
    const byUser = new Map<string, { userId: string; dedupeKey: string; sentAt: Date }[]>();
    for (const row of prior) {
      if (!row.dedupeKey.startsWith(VIBE_DEDUPE_PREFIX)) continue;
      const sentAt = new Date(row.sentAt);
      if (Number.isNaN(sentAt.getTime()) || sentAt < weekAgo) continue;
      const list = byUser.get(row.userId) ?? [];
      list.push({ userId: row.userId, dedupeKey: row.dedupeKey, sentAt });
      byUser.set(row.userId, list);
    }

    for (const row of ready) {
      const sends = byUser.get(row.member.id) ?? [];
      const unseen = row.options.filter((option) => !sends.some((send) => send.dedupeKey === vibeDedupeKey(option.item.kind, option.item.id)));
      // Already told them about every current match. The cap is not why.
      if (unseen.length === 0) {
        result.skippedDuplicate += 1;
        continue;
      }
      const today = sends.filter((send) => send.sentAt >= dayStart).length;
      if (today >= VIBE_MAX_SENDS_PER_DAY || sends.length >= VIBE_MAX_SENDS_PER_WEEK) {
        result.skippedCaps += 1;
        continue;
      }
      let claimed = false;
      for (const option of unseen) {
        const key = vibeDedupeKey(option.item.kind, option.item.id);
        if (!(await claimNotificationSend(row.member.id, key))) continue;
        await deliver({
          userIds: [row.member.id],
          category: 'vibe',
          title: option.copy.title,
          body: option.copy.body,
          url: option.copy.url,
          type: 'vibe.match',
        });
        result.sent += 1;
        claimed = true;
        break;
      }
      if (!claimed) result.skippedDuplicate += 1;
    }
  }

  if (ownsCursor) await writeSince(now, redis);
  return result;
}
