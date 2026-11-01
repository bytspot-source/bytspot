import { z } from 'zod';

/**
 * Music a host declares on a Party. Null kind means the host said nothing
 * about music, so the Party never reaches a music surface.
 */
export const musicKinds = ['live', 'dj', 'both'] as const;
export type MusicKind = (typeof musicKinds)[number];

/** Fixed list so filters stay consistent; at most two per Party. */
export const musicGenres = [
  'afrobeats', 'amapiano', 'hip-hop', 'r-and-b', 'jazz',
  'reggae-dancehall', 'house', 'gospel', 'latin', 'live-band',
] as const;
export type MusicGenre = (typeof musicGenres)[number];
export const MAX_MUSIC_GENRES = 2;

/** A Party with no end time is treated as running this long. */
const OPEN_ENDED_MS = 6 * 60 * 60 * 1000;
/** A music window wider than this is a browse query, not "tonight" or "this weekend". */
export const MAX_MUSIC_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

export const musicInput = z.object({
  kind: z.enum(musicKinds),
  genres: z.array(z.enum(musicGenres)).min(1).max(MAX_MUSIC_GENRES)
    .refine((genres) => new Set(genres).size === genres.length, 'Each genre can be picked once.'),
  setStartsAt: z.string().datetime({ offset: true }).nullish(),
}).strict();
export type MusicInput = z.infer<typeof musicInput>;

export const musicWindowInput = z.object({
  from: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  kinds: z.array(z.enum(['live', 'dj'])).max(2).optional(),
  genres: z.array(z.enum(musicGenres)).max(musicGenres.length).optional(),
}).strict().superRefine((input, ctx) => {
  const span = Date.parse(input.until) - Date.parse(input.from);
  if (span <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['until'], message: 'The music window must end after it starts.' });
  else if (span > MAX_MUSIC_WINDOW_MS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['until'], message: 'The music window can span at most 4 days.' });
});
export type MusicWindowInput = z.infer<typeof musicWindowInput>;

export function partyRunsUntil(party: { startsAt: Date; endsAt: Date | null }): Date {
  return party.endsAt ?? new Date(party.startsAt.getTime() + OPEN_ENDED_MS);
}

/** Null when the set time is acceptable; otherwise the reason it is not. */
export function musicSetTimeProblem(setStartsAt: Date | null, party: { startsAt: Date; endsAt: Date | null }): string | null {
  if (!setStartsAt) return null;
  if (setStartsAt.getTime() < party.startsAt.getTime()) return 'The set cannot start before the Party.';
  if (setStartsAt.getTime() >= partyRunsUntil(party).getTime()) return 'The set has to start before the Party ends.';
  return null;
}

export type StoredMusic = { musicKind: string | null; musicGenres: string[]; musicSetStartsAt: Date | null };

export function storedMusic(music: MusicInput | null | undefined): StoredMusic {
  if (!music) return { musicKind: null, musicGenres: [], musicSetStartsAt: null };
  return { musicKind: music.kind, musicGenres: [...music.genres], musicSetStartsAt: music.setStartsAt ? new Date(music.setStartsAt) : null };
}

export type MusicListing = { kind: MusicKind; genres: MusicGenre[]; setStartsAt: string | null };

/** What a guest is told. Unknown stored values are dropped rather than shown. */
export function musicListing(party: StoredMusic): MusicListing | null {
  if (!(musicKinds as readonly string[]).includes(party.musicKind ?? '')) return null;
  const genres = party.musicGenres.filter((genre): genre is MusicGenre => (musicGenres as readonly string[]).includes(genre)).slice(0, MAX_MUSIC_GENRES);
  return { kind: party.musicKind as MusicKind, genres, setStartsAt: party.musicSetStartsAt?.toISOString() ?? null };
}

/**
 * A Party belongs in a music window when it declares music, is open to anyone
 * (no approval door, no circle audience), overlaps the window, and matches the
 * guest's kind and genre filters. Both live and DJ match a Party that has both.
 */
export function matchesMusicWindow(
  party: StoredMusic & { startsAt: Date; endsAt: Date | null; accessMode: string; audienceCircleIds: string[] },
  window: MusicWindowInput,
): boolean {
  const listing = musicListing(party);
  if (!listing) return false;
  if (party.accessMode === 'private-approval' || party.audienceCircleIds.length > 0) return false;
  const from = Date.parse(window.from);
  const until = Date.parse(window.until);
  if (party.startsAt.getTime() >= until || partyRunsUntil(party).getTime() <= from) return false;
  if (window.kinds && window.kinds.length > 0 && listing.kind !== 'both' && !window.kinds.includes(listing.kind)) return false;
  if (window.genres && window.genres.length > 0 && !listing.genres.some((genre) => window.genres!.includes(genre))) return false;
  return true;
}

/** The same rule as `matchesMusicWindow`, as a query clause so ineligible rows never take a page slot. */
export function musicWindowWhere(window: MusicWindowInput) {
  const from = new Date(window.from);
  const until = new Date(window.until);
  const kinds = window.kinds && window.kinds.length > 0 ? [...window.kinds, 'both'] : [...musicKinds];
  return [
    { musicKind: { in: kinds } },
    { accessMode: { not: 'private-approval' } },
    { audienceCircleIds: { isEmpty: true } },
    { startsAt: { lt: until } },
    { OR: [{ endsAt: { gt: from } }, { endsAt: null, startsAt: { gt: new Date(from.getTime() - OPEN_ENDED_MS) } }] },
    ...(window.genres && window.genres.length > 0 ? [{ musicGenres: { hasSome: [...window.genres] } }] : []),
  ];
}

/** Free, RSVP, or the lowest paid ticket. Never a price the host did not set. */
export function musicEntry(accessMode: string, ticketTiers: unknown): { kind: 'free' | 'ticket'; fromCents: number | null } {
  if (accessMode !== 'paid-ticket') return { kind: 'free', fromCents: null };
  const prices = Array.isArray(ticketTiers)
    ? ticketTiers.map((tier) => (tier && typeof tier === 'object' ? (tier as { priceCents?: unknown }).priceCents : null))
      .filter((price): price is number => typeof price === 'number' && Number.isInteger(price) && price > 0)
    : [];
  return { kind: 'ticket', fromCents: prices.length > 0 ? Math.min(...prices) : null };
}
