import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { firstName, holdingsForGuest, linkSource, type BookingDto } from './bookings';
import {
  READ_NDEF,
  SELECT_APP,
  SELECT_NDEF_FILE,
  authAnswer,
  authFinish,
  authStart,
  changeKey,
  enableSdm,
  ndefTemplate,
  readNdefUrl,
  responseVerified,
  statusOf,
  writeNdef,
  KEY_APP,
  KEY_FILE_READ,
  KEY_META_READ,
} from './ntag424';
import { itemKeys, parseSunCode, verifySun, type SunTap } from './sun';

/**
 * Bytspot bands, and the other NFC items that share their rules.
 *
 * Each band's NFC chip and printed QR code carry bytspot.app/<serial>, for
 * example bytspot.app/BYT424-0301. Bytspot assigns ranges of serials to a
 * business; the business activates each band, choosing the place it admits to
 * and its tier, and marks it lost when it goes missing. A band that is not
 * active opens nothing.
 *
 * Each item is one of five forms, chosen on activation: a band, a card for a
 * stay, an event fob for a show, a key fob for a regular member, or an epoxy
 * tag fixed to a restaurant table. At the door a carried item is linked to its
 * guest from a paid ticket or an accepted booking. After that a tap finds what
 * the guest holds for now, its own rail first, and checking in is the same
 * single step as for the pass. A table tag is never linked to a guest.
 *
 * An item whose NTAG 424 DNA chip adds a fresh code to its link is secured on
 * its first tap with a valid code. From then on every tap needs a new code, so
 * a copied link, a copied chip or the printed number opens nothing.
 */

export const BAND_TIERS = ['green', 'platinum', 'black'] as const;
export type BandTier = (typeof BAND_TIERS)[number];
export type BandState = 'assigned' | 'active' | 'lost';

export const BAND_FORMS = ['band', 'card', 'event_fob', 'key_fob', 'epoxy'] as const;
export type BandForm = (typeof BAND_FORMS)[number];

interface FormRule {
  /** What the console calls it in a sentence. */
  noun: string;
  /** The window domains a tap lists first: the item's Discover rail. */
  domains: readonly string[];
  /** A guest carries it, so it links to them. A table tag stays put. */
  carried: boolean;
  /** `booking`: the link ends when the booking it came from ends. */
  linkEnds: 'booking' | 'never';
}

export const FORM_RULES: Record<BandForm, FormRule> = {
  band: { noun: 'band', domains: ['nightlife'], carried: true, linkEnds: 'never' },
  card: { noun: 'card', domains: ['stay'], carried: true, linkEnds: 'booking' },
  event_fob: { noun: 'event fob', domains: ['events'], carried: true, linkEnds: 'booking' },
  key_fob: { noun: 'key fob', domains: ['wellness', 'fitness', 'automotive', 'stall', 'green'], carried: true, linkEnds: 'never' },
  epoxy: { noun: 'table tag', domains: ['dining', 'coffee'], carried: false, linkEnds: 'never' },
};

/** A key fob visit within this many hours of the last one is the same visit. */
export const VISIT_GAP_HOURS = 4;

/** After a secured item's tap, staff may log the visit for this long without tapping again. */
export const TAP_HOLD_MINUTES = 5;

/** The most serials one admin action may assign or release. */
export const MAX_BAND_RANGE = 1000;

const SERIAL = /^(BYT\d{3})-?(\d{4})(?:-?[GPB])?$/;

/**
 * The serial from a typed value, a scanned QR code or a tapped link:
 * `BYT424-0301`, `byt424-0301-b`, `https://bytspot.app/BYT424-0301`,
 * `bytspot.app/p/BYT424-0301-B` and `bytspot.app/BYT424?patchId=BYT424-0301`
 * all read as `BYT424-0301`. The tier letter some links end with is dropped.
 */
export function parseBandSerial(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let value = raw.trim();
  if (!value || value.length > 300) return undefined;
  if (value.includes('/')) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
      const named = url.searchParams.get('patchId') ?? url.searchParams.get('patch');
      value = named ?? url.pathname.split('/').filter(Boolean).pop() ?? '';
    } catch {
      return undefined;
    }
  }
  const match = SERIAL.exec(value.toUpperCase());
  return match ? `${match[1]}-${match[2]}` : undefined;
}

export class BandRangeRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Every serial from `from` to `to`, both included. */
export function bandRange(from: unknown, to: unknown): string[] {
  const first = parseBandSerial(from);
  const last = parseBandSerial(to);
  if (!first || !last) throw new BandRangeRefused('Use band numbers like BYT424-0301.');
  const [prefix, start] = first.split('-');
  const [lastPrefix, end] = last.split('-');
  if (prefix !== lastPrefix) throw new BandRangeRefused('Both band numbers need the same start, like BYT424.');
  const a = Number(start);
  const b = Number(end);
  if (b < a) throw new BandRangeRefused('The last band number comes before the first.');
  if (b - a + 1 > MAX_BAND_RANGE) throw new BandRangeRefused(`Assign at most ${MAX_BAND_RANGE} bands at a time.`);
  return Array.from({ length: b - a + 1 }, (_, i) => `${prefix}-${String(a + i).padStart(4, '0')}`);
}

/** Sorted serials as runs, e.g. ["BYT424-0301 – BYT424-0400", "BYT424-0450"]. */
export function bandRuns(serials: string[]): string[] {
  const sorted = [...serials].sort();
  const runs: string[] = [];
  let start = '';
  let prev = '';
  const close = () => {
    if (start) runs.push(start === prev ? start : `${start} – ${prev}`);
  };
  for (const serial of sorted) {
    const [prefix, digits] = serial.split('-');
    const [prevPrefix, prevDigits] = prev.split('-');
    if (start && prefix === prevPrefix && Number(digits) === Number(prevDigits) + 1) {
      prev = serial;
      continue;
    }
    close();
    start = serial;
    prev = serial;
  }
  close();
  return runs;
}

export interface BandSummary {
  total: number;
  active: number;
  lost: number;
  ranges: string[];
}

/** What each business holds, for the admin list. */
export async function bandSummaries(sellerIds: string[]): Promise<Map<string, BandSummary>> {
  const summaries = new Map<string, BandSummary>();
  if (!sellerIds.length) return summaries;
  const rows = await db.vendorBand.findMany({
    where: { sellerId: { in: sellerIds } },
    select: { sellerId: true, serial: true, state: true },
  });
  const serials = new Map<string, string[]>();
  for (const row of rows) {
    const entry = summaries.get(row.sellerId) ?? { total: 0, active: 0, lost: 0, ranges: [] };
    entry.total += 1;
    if (row.state === 'active') entry.active += 1;
    if (row.state === 'lost') entry.lost += 1;
    summaries.set(row.sellerId, entry);
    serials.set(row.sellerId, [...(serials.get(row.sellerId) ?? []), row.serial]);
  }
  for (const [sellerId, entry] of summaries) entry.ranges = bandRuns(serials.get(sellerId) ?? []);
  return summaries;
}

export interface AssignedBands {
  added: number;
  alreadyHere: number;
}

/**
 * Assigns a range to one business. Refused whole if any band in it belongs to
 * another business, so a typo cannot quietly split a range between two.
 */
export async function assignBands(sellerId: string, adminUserId: string, from: unknown, to: unknown): Promise<AssignedBands> {
  const serials = bandRange(from, to);
  const existing = await db.vendorBand.findMany({
    where: { serial: { in: serials } },
    select: { serial: true, sellerId: true },
  });
  const elsewhere = existing.filter((row) => row.sellerId !== sellerId).map((row) => row.serial).sort();
  if (elsewhere.length) {
    const shown = elsewhere.slice(0, 5).join(', ');
    throw new BandRangeRefused(
      `${elsewhere.length === 1 ? 'This band belongs' : `${elsewhere.length} of these bands belong`} to another business: ${shown}${elsewhere.length > 5 ? '…' : '.'}`,
    );
  }
  const { count } = await db.vendorBand.createMany({
    data: serials.map((serial) => ({ serial, sellerId, assignedByUserId: adminUserId })),
    skipDuplicates: true,
  });
  return { added: count, alreadyHere: serials.length - count };
}

/** Takes back bands in a range that the business never activated. Active and lost bands stay. */
export async function releaseBands(sellerId: string, from: unknown, to: unknown): Promise<{ released: number; kept: number }> {
  const serials = bandRange(from, to);
  const held = await db.vendorBand.count({ where: { sellerId, serial: { in: serials } } });
  const { count } = await db.vendorBand.deleteMany({ where: { sellerId, serial: { in: serials }, state: 'assigned' } });
  return { released: count, kept: held - count };
}

export interface BandDto {
  id: string;
  serial: string;
  form: BandForm;
  state: BandState;
  tier: BandTier | null;
  vendorCode: string | null;
  locationId: string | null;
  place: string | null;
  activatedAt: string | null;
  lostAt: string | null;
  /** First name of the guest it is linked to now. */
  holder: string | null;
  linkedAt: string | null;
  /** When the link ends by itself, for a card or an event fob. */
  linkedUntil: string | null;
  /** Its chip makes a fresh code on every tap, and the door checks it. */
  secured: boolean;
}

const BAND_INCLUDE = { location: { select: { label: true } }, holder: { select: { name: true } } } as const;

type BandRow = Prisma.VendorBandGetPayload<{ include: typeof BAND_INCLUDE }>;

function bandState(raw: string): BandState {
  return raw === 'active' || raw === 'lost' ? raw : 'assigned';
}

function bandTier(raw: string | null): BandTier | null {
  return BAND_TIERS.includes(raw as BandTier) ? (raw as BandTier) : null;
}

export function bandForm(raw: string | null | undefined): BandForm {
  return BAND_FORMS.includes(raw as BandForm) ? (raw as BandForm) : 'band';
}

/** The guest an item is linked to now; a card past its stay or a fob past its show is free again. */
export function currentHolder(row: { holderUserId: string | null; linkedUntil: Date | null }, now: Date): string | null {
  if (!row.holderUserId) return null;
  return !row.linkedUntil || row.linkedUntil > now ? row.holderUserId : null;
}

export function toBandDto(row: BandRow, now: Date = new Date()): BandDto {
  const linked = currentHolder(row, now) !== null;
  return {
    id: row.id,
    serial: row.serial,
    form: bandForm(row.form),
    state: bandState(row.state),
    tier: bandTier(row.tier),
    vendorCode: row.vendorCode,
    locationId: row.locationId,
    place: row.location?.label ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    lostAt: row.lostAt?.toISOString() ?? null,
    holder: linked ? (firstName(row.holder?.name) ?? 'Guest') : null,
    linkedAt: linked ? (row.linkedAt?.toISOString() ?? null) : null,
    linkedUntil: linked ? (row.linkedUntil?.toISOString() ?? null) : null,
    secured: Boolean(row.securedAt),
  };
}

export async function listBands(sellerId: string, now: Date = new Date()): Promise<BandDto[]> {
  const rows = await db.vendorBand.findMany({ where: { sellerId }, include: BAND_INCLUDE, orderBy: { serial: 'asc' } });
  return rows.map((row) => toBandDto(row, now));
}

export class BandRefused extends Error {
  constructor(
    readonly blockers: string[],
    readonly status: 404 | 409 = 409,
  ) {
    super(blockers.join('; '));
  }
}

const vendorCode = z.string().trim().min(1).max(40);

export const activateBandInput = z
  .object({
    /** A band number, or the link its QR code or chip carries. */
    band: z.string().trim().min(1).max(300),
    form: z.enum(BAND_FORMS).default('band'),
    locationId: z.string().trim().min(1).max(64),
    /** Required for a band; optional for the other forms. */
    tier: z.enum(BAND_TIERS).optional(),
    vendorCode: vendorCode.optional(),
  })
  .refine((input) => input.form !== 'band' || input.tier !== undefined, { path: ['tier'] });
export type ActivateBandInput = z.input<typeof activateBandInput>;

export const editBandInput = z
  .object({
    form: z.enum(BAND_FORMS).optional(),
    locationId: z.string().trim().min(1).max(64).optional(),
    tier: z.enum(BAND_TIERS).optional(),
    /** Null clears it. */
    vendorCode: vendorCode.nullable().optional(),
  })
  .refine((edit) => edit.form !== undefined || edit.locationId !== undefined || edit.tier !== undefined || edit.vendorCode !== undefined);
export type EditBandInput = z.infer<typeof editBandInput>;

async function requirePlace(sellerId: string, locationId: string): Promise<void> {
  const place = await db.vendorLocation.findFirst({
    where: { id: locationId, sellerId, state: { not: 'CLOSED' } },
    select: { id: true },
  });
  if (!place) throw new BandRefused(['Choose one of your places']);
}

function isVendorCodeTaken(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

const CODE_TAKEN = 'Another band already uses that code';
const NOT_A_SERIAL = 'That is not a Bytspot band or tag number, like BYT424-0301';

/**
 * Activates a band this business holds. Activating one that is already active
 * returns it unchanged, so a second tap at the counter is not an error.
 */
export async function activateBand(
  sellerId: string,
  seatId: string,
  input: ActivateBandInput,
  now: Date = new Date(),
): Promise<{ band: BandDto; alreadyActive: boolean }> {
  const serial = parseBandSerial(input.band);
  if (!serial) throw new BandRefused([NOT_A_SERIAL]);

  // Another business's band reads as unknown, so its serials cannot be probed.
  const band = await db.vendorBand.findFirst({ where: { serial, sellerId }, include: BAND_INCLUDE });
  if (!band) throw new BandRefused([`${serial} is not one of your bands`], 404);
  if (band.state === 'lost') throw new BandRefused([`${serial} was marked lost and cannot be used again`]);
  if (band.state === 'active') return { band: toBandDto(band), alreadyActive: true };

  await requirePlace(sellerId, input.locationId);
  try {
    const { count } = await db.vendorBand.updateMany({
      where: { id: band.id, sellerId, state: 'assigned' },
      data: {
        state: 'active',
        form: input.form ?? 'band',
        locationId: input.locationId,
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.vendorCode ? { vendorCode: input.vendorCode } : {}),
        activatedAt: now,
        activatedBySeatId: seatId,
      },
    });
    const row = await db.vendorBand.findUniqueOrThrow({ where: { id: band.id }, include: BAND_INCLUDE });
    if (count === 0 && row.state !== 'active') throw new BandRefused([`${serial} was marked lost and cannot be used again`]);
    return { band: toBandDto(row), alreadyActive: count === 0 };
  } catch (err) {
    if (isVendorCodeTaken(err)) throw new BandRefused([CODE_TAKEN]);
    throw err;
  }
}

/**
 * Changes a band's form, place, tier or code. A lost band is kept as it was,
 * and an item linked to a guest keeps its form until the link ends.
 */
export async function editBand(sellerId: string, id: string, edit: EditBandInput, now: Date = new Date()): Promise<BandDto> {
  const band = await db.vendorBand.findFirst({
    where: { id, sellerId },
    select: { id: true, state: true, form: true, tier: true, holderUserId: true, linkedUntil: true },
  });
  if (!band) throw new BandRefused(['That band is not here'], 404);
  if (band.state === 'lost') throw new BandRefused(['A lost band cannot be changed']);
  if (edit.form && edit.form !== band.form) {
    if (currentHolder(band, now)) throw new BandRefused([`It is linked to a guest, so it stays a ${FORM_RULES[bandForm(band.form)].noun} for now`]);
    if (edit.form === 'band' && !edit.tier && !band.tier) throw new BandRefused(['Choose a tier for a band']);
  }
  if (edit.locationId) await requirePlace(sellerId, edit.locationId);
  try {
    const { count } = await db.vendorBand.updateMany({
      where: { id, sellerId, state: { not: 'lost' } },
      data: {
        ...(edit.form ? { form: edit.form } : {}),
        ...(edit.locationId ? { locationId: edit.locationId } : {}),
        ...(edit.tier ? { tier: edit.tier } : {}),
        ...(edit.vendorCode !== undefined ? { vendorCode: edit.vendorCode } : {}),
      },
    });
    if (count === 0) throw new BandRefused(['A lost band cannot be changed']);
  } catch (err) {
    if (isVendorCodeTaken(err)) throw new BandRefused([CODE_TAKEN]);
    throw err;
  }
  return toBandDto(await db.vendorBand.findUniqueOrThrow({ where: { id }, include: BAND_INCLUDE }));
}

/** Stops a band opening anything, for good. The guest gets a new band. */
export async function markBandLost(sellerId: string, id: string, now: Date = new Date()): Promise<BandDto> {
  const { count } = await db.vendorBand.updateMany({
    where: { id, sellerId, state: { not: 'lost' } },
    data: { state: 'lost', lostAt: now },
  });
  const row = await db.vendorBand.findFirst({ where: { id, sellerId }, include: BAND_INCLUDE });
  if (!row) throw new BandRefused(['That band is not here'], 404);
  if (count === 0 && row.state !== 'lost') throw new BandRefused(['That did not go through. Try again']);
  return toBandDto(row);
}

/** The chip's UID and counter when the code checks out for this item. */
function checkTap(serial: string, raw: string): { tap?: SunTap; coded: boolean; checkable: boolean } {
  const code = parseSunCode(raw);
  if (!code) return { coded: false, checkable: Boolean(config.bandSunMasterKey) };
  if (!config.bandSunMasterKey) return { coded: true, checkable: false };
  return { tap: verifySun(itemKeys(Buffer.from(config.bandSunMasterKey, 'hex'), serial), code), coded: true, checkable: true };
}

/**
 * An active item of this business, or the refusal a door shows for it.
 *
 * A tap with a valid fresh code moves the item's counter on, and secures the
 * item the first time. A secured item then needs a new code on every tap; with
 * `hold`, a tap in the last TAP_HOLD_MINUTES also counts, so staff can act on
 * what they just read. An item that is not secured reads as before.
 */
async function bandAtTheDoor(sellerId: string, raw: string, now: Date, hold = false): Promise<BandRow> {
  const serial = parseBandSerial(raw);
  if (!serial) throw new BandRefused([NOT_A_SERIAL]);
  const band = await db.vendorBand.findFirst({ where: { serial, sellerId }, include: BAND_INCLUDE });
  if (!band) throw new BandRefused([`${serial} is not one of your bands or tags`], 404);
  const noun = FORM_RULES[bandForm(band.form)].noun;
  if (band.state === 'lost') throw new BandRefused([`${serial} was marked lost. Scan the guest's pass instead`]);
  if (band.state !== 'active') throw new BandRefused([`${serial} is not activated yet. Activate this ${noun} under Bands`]);

  const { tap, coded, checkable } = checkTap(serial, raw);
  if (!tap) {
    if (!band.securedAt) return band;
    if (!checkable) throw new BandRefused([`Secured items cannot be checked right now. Scan the guest's pass instead`]);
    if (!coded && hold && band.lastTapAt && now.getTime() - band.lastTapAt.getTime() <= TAP_HOLD_MINUTES * 60_000) return band;
    if (!coded) throw new BandRefused([`${serial} is secured, so its printed number is not enough. Tap the ${noun} on the phone, or scan the guest's pass`]);
    throw new BandRefused([`This tap did not check out, so it may be a copy of ${serial}. Scan the guest's pass instead`]);
  }
  if (band.sunUid && band.sunUid !== tap.uid) {
    throw new BandRefused([`This tap did not check out, so it may be a copy of ${serial}. Scan the guest's pass instead`]);
  }
  const replay = new BandRefused([`That tap of ${serial} was already used. Tap the ${noun} again`]);
  if (band.sunCounter != null && tap.counter <= band.sunCounter) throw replay;
  const { count } = await db.vendorBand.updateMany({
    where: {
      id: band.id,
      state: 'active',
      sunUid: band.sunUid ?? null,
      sunCounter: band.sunCounter == null ? null : { lt: tap.counter },
    },
    data: { sunUid: tap.uid, sunCounter: tap.counter, lastTapAt: now, ...(band.securedAt ? {} : { securedAt: now }) },
  });
  if (count === 0) throw replay;
  return { ...band, sunUid: tap.uid, sunCounter: tap.counter, lastTapAt: now, securedAt: band.securedAt ?? now };
}

export interface MemberVisits {
  visits: number;
  lastVisitAt: string | null;
}

export interface BandAtDoor {
  band: BandDto;
  /** What the linked guest holds for now, the item's own rail first. */
  bookings: BookingDto[];
  /** A key fob member's visits to this business. */
  member?: MemberVisits;
}

async function memberVisits(sellerId: string, userId: string): Promise<MemberVisits> {
  const [visits, last] = await Promise.all([
    db.vendorBandVisit.count({ where: { sellerId, userId } }),
    db.vendorBandVisit.findFirst({ where: { sellerId, userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  return { visits, lastVisitAt: last?.createdAt.toISOString() ?? null };
}

/**
 * Reads an item. It changes no booking: checking in is a separate, explicit
 * step. A secured item's tap is used up. An assigned-scope seat sees bookings
 * on its windows only.
 */
export async function readBand(sellerId: string, raw: string, now: Date = new Date(), windowIds?: string[]): Promise<BandAtDoor> {
  const row = await bandAtTheDoor(sellerId, raw, now);
  const band = toBandDto(row, now);
  const userId = currentHolder(row, now);
  const form = bandForm(row.form);
  if (!userId || !FORM_RULES[form].carried) return { band, bookings: [] };
  const [bookings, member] = await Promise.all([
    holdingsForGuest({ sellerId, userId, locationId: row.locationId, domains: FORM_RULES[form].domains, windowIds, now }),
    form === 'key_fob' ? memberVisits(sellerId, userId) : Promise.resolve(undefined),
  ]);
  return member ? { band, bookings, member } : { band, bookings };
}

/**
 * Links a carried item to the guest of a paid ticket or an accepted booking,
 * so the next tap finds them. A card or an event fob stays linked until that
 * booking ends; a band or a key fob until it is lost. Linking the same guest
 * again keeps the link, and an item linked to someone else is refused.
 */
export async function linkBand(input: {
  sellerId: string;
  seatId: string;
  band: string;
  bookingId: string;
  windowIds?: string[];
  now?: Date;
}): Promise<BandDto> {
  const now = input.now ?? new Date();
  const row = await bandAtTheDoor(input.sellerId, input.band, now);
  const rule = FORM_RULES[bandForm(row.form)];
  if (!rule.carried) throw new BandRefused([`${row.serial} is a table tag. It stays at its table, and diners tap it with their own phone`]);
  const source = await linkSource({ sellerId: input.sellerId, bookingId: input.bookingId, windowIds: input.windowIds });
  if (!source) throw new BandRefused([`A ${rule.noun} links to a paid ticket or a booking. Scan the guest's pass first`], 404);
  if (row.locationId && row.locationId !== source.locationId) {
    throw new BandRefused([`${row.serial} is for ${row.location?.label ?? 'another place'}. Use one for this place`]);
  }
  if (source.endsAt <= now) throw new BandRefused(['That booking has ended. Link it from a booking for now']);
  const linkedUntil = rule.linkEnds === 'booking' ? source.endsAt : null;
  const holder = currentHolder(row, now);
  if (holder && holder !== source.userId) throw new BandRefused([`${row.serial} is linked to another guest. Give this guest a new ${rule.noun}`]);
  if (holder && (!row.linkedUntil || (linkedUntil && linkedUntil <= row.linkedUntil))) return toBandDto(row, now);

  const { count } = await db.vendorBand.updateMany({
    where: {
      id: row.id,
      sellerId: input.sellerId,
      state: 'active',
      OR: holder ? [{ holderUserId: holder }] : [{ holderUserId: null }, { linkedUntil: { lte: now } }],
    },
    data: holder ? { linkedUntil } : { holderUserId: source.userId, linkedAt: now, linkedBySeatId: input.seatId, linkedUntil },
  });
  const linked = await db.vendorBand.findUniqueOrThrow({ where: { id: row.id }, include: BAND_INCLUDE });
  if (count === 0 && currentHolder(linked, now) !== source.userId) {
    throw new BandRefused([`${row.serial} was just linked to another guest. Give this guest a new ${rule.noun}`]);
  }
  return toBandDto(linked, now);
}

/**
 * Logs a key fob member's visit. A second tap within VISIT_GAP_HOURS is the
 * same visit, so it is counted once. A secured fob read in the last
 * TAP_HOLD_MINUTES needs no new tap.
 */
export async function logVisit(input: {
  sellerId: string;
  seatId: string;
  band: string;
  now?: Date;
}): Promise<{ member: MemberVisits; alreadyLogged: boolean }> {
  const now = input.now ?? new Date();
  const row = await bandAtTheDoor(input.sellerId, input.band, now, true);
  if (bandForm(row.form) !== 'key_fob') throw new BandRefused(['Visits are logged for key fob members']);
  const userId = currentHolder(row, now);
  if (!userId) throw new BandRefused([`${row.serial} is not linked to a member yet. Scan their pass, then link the key fob`]);
  const recent = await db.vendorBandVisit.findFirst({
    where: { sellerId: input.sellerId, userId, createdAt: { gt: new Date(now.getTime() - VISIT_GAP_HOURS * 3_600_000) } },
    select: { id: true },
  });
  if (!recent) await db.vendorBandVisit.create({ data: { sellerId: input.sellerId, bandId: row.id, userId, seatId: input.seatId, createdAt: now } });
  return { member: await memberVisits(input.sellerId, userId), alreadyLogged: Boolean(recent) };
}

/**
 * Turning on an item's fresh code from a phone.
 *
 * The phone sends each APDU the server gives it to the chip, in order, stops
 * at the first one the chip refuses, and posts every answer back with the
 * state it was given. The state is sealed with a key from the master key, so
 * the phone can neither read nor change it. The steps:
 *
 * 1. Read the chip's link.
 * 2. Write the link with room for the code, and authenticate with key 0.
 * 3. Turn the code on and set the item's three keys, key 0 last, since
 *    changing it ends the session.
 * 4. Read the link back. Only a valid fresh code from this chip secures it.
 *
 * A chip left half done is finished, not refused: a chip that already gives a
 * valid code is secured once Bytspot's key 0 opens it; a key already set to
 * Bytspot's makes the chip refuse the change, and the next round uses it as
 * the old key; and when the factory key 0 no longer opens the chip, Bytspot's
 * is tried.
 */

const FACTORY_KEY = Buffer.alloc(16);
const SECURE_STATE_MINUTES = 3;
const MAX_SECURE_ROUNDS = 10;

type ApduKind = 'selectApp' | 'selectFile' | 'read' | 'write' | 'auth1' | 'auth2' | 'sdm' | 'key1' | 'key2' | 'key0';
type Key0 = 'factory' | 'bytspot';

interface SecureState {
  sellerId: string;
  bandId: string;
  uid: string;
  exp: number;
  round: number;
  sent: ApduKind[];
  /** The key 0 this round authenticates with, and the ones tried so far. */
  key0: Key0;
  tried: Key0[];
  /** Keys a half-done run already set to Bytspot's. */
  changed: number[];
  /** A valid code read before Bytspot's key 0 was confirmed. */
  pending?: SunTap;
  rndA?: string;
  rndB?: string;
  macKey?: string;
  ti?: string;
}

export interface SecureStep {
  /** The next APDUs, as hex, for the phone to send in order. */
  apdus: string[];
  state: string;
}

export const secureBandInput = z.object({
  /** The link read from the chip, or the item number. */
  band: z.string().trim().min(1).max(300),
  /** The chip's UID as the phone read it. */
  uid: z.string().trim().regex(/^[0-9a-fA-F]+$/).max(32),
  state: z.string().max(4000).optional(),
  responses: z.array(z.string().regex(/^[0-9a-fA-F]*$/).max(600)).max(10).optional(),
});
export type SecureBandInput = z.infer<typeof secureBandInput>;

function stateKey(master: Buffer): Buffer {
  return createHmac('sha256', master).update('bytspot-secure-state').digest();
}

function seal(master: Buffer, state: SecureState): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', stateKey(master), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function unseal(master: Buffer, sealed: string): SecureState | undefined {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', stateKey(master), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as SecureState;
  } catch {
    return undefined;
  }
}

const HOLD_STILL = 'The chip stopped answering. Hold it still against the top of the phone and try again';
const OTHER_KEYS = 'This chip was set up with other keys, so Bytspot cannot secure it. Ask Bytspot for another';

/**
 * One round of securing an item. Without `state` it starts; each answer
 * returns the next APDUs, until the item comes back secured.
 */
export async function secureBand(sellerId: string, input: SecureBandInput, now: Date = new Date()): Promise<SecureStep | { band: BandDto }> {
  if (!config.bandSunMasterKey) throw new BandRefused(['Securing is not set up yet. Ask Bytspot to turn it on']);
  const master = Buffer.from(config.bandSunMasterKey, 'hex');
  const serial = parseBandSerial(input.band);
  if (!serial) throw new BandRefused([NOT_A_SERIAL]);
  const band = await db.vendorBand.findFirst({ where: { serial, sellerId }, include: BAND_INCLUDE });
  if (!band) throw new BandRefused([`${serial} is not one of your bands or tags`], 404);
  if (band.state === 'lost') throw new BandRefused([`${serial} was marked lost and cannot be used again`]);
  if (band.securedAt) return { band: toBandDto(band, now) };
  const uid = input.uid.toUpperCase();
  if (uid.length !== 14) throw new BandRefused(['This chip hides its number, so it cannot be secured. Ask Bytspot for another']);
  const keys = itemKeys(master, serial);
  const key0 = (which: Key0) => (which === 'bytspot' ? keys.appKey : FACTORY_KEY);

  type Carry = Pick<SecureState, 'round' | 'key0' | 'tried' | 'changed' | 'pending'>;
  const next = (carry: Carry, sent: ApduKind[], apdus: Buffer[], extra: Partial<SecureState> = {}): SecureStep => ({
    apdus: apdus.map((apdu) => apdu.toString('hex').toUpperCase()),
    state: seal(master, { ...carry, ...extra, sent, sellerId, bandId: band.id, uid, exp: now.getTime() + SECURE_STATE_MINUTES * 60_000 }),
  });
  const authWith = (carry: Carry, which: Key0) =>
    next({ ...carry, key0: which, tried: carry.tried.includes(which) ? carry.tried : [...carry.tried, which] }, ['selectApp', 'auth1'], [
      SELECT_APP,
      authStart(KEY_APP),
    ]);

  if (!input.state) {
    return next({ round: 1, key0: 'factory', tried: [], changed: [] }, ['selectApp', 'selectFile', 'read'], [SELECT_APP, SELECT_NDEF_FILE, READ_NDEF]);
  }
  const state = unseal(master, input.state);
  if (!state || state.sellerId !== sellerId || state.bandId !== band.id || state.uid !== uid) {
    throw new BandRefused(['Start again, and tap the same item'], 409);
  }
  if (state.exp < now.getTime()) throw new BandRefused(['That took too long. Start again'], 409);
  if (state.round >= MAX_SECURE_ROUNDS) throw new BandRefused(['This chip could not be secured. Ask Bytspot for another']);
  const answers = (input.responses ?? []).map((hex) => Buffer.from(hex, 'hex'));
  const answer = (kind: ApduKind) => {
    const index = state.sent.lastIndexOf(kind);
    return index >= 0 ? answers[index] : undefined;
  };
  const carry: Carry = { round: state.round + 1, key0: state.key0, tried: state.tried, changed: state.changed, pending: state.pending };

  const secure = async (tap: SunTap) => {
    const { count } = await db.vendorBand.updateMany({
      where: { id: band.id, sellerId, state: { not: 'lost' }, securedAt: null },
      data: { sunUid: tap.uid, sunCounter: tap.counter, securedAt: now },
    });
    const row = await db.vendorBand.findUniqueOrThrow({ where: { id: band.id }, include: BAND_INCLUDE });
    if (count === 0 && !row.securedAt) throw new BandRefused(['That did not go through. Try again']);
    return { band: toBandDto(row, now) };
  };

  // Steps 1 and 4: the link read from the chip.
  if (state.sent.includes('read')) {
    const readBack = answer('read');
    const finished = state.sent.includes('sdm');
    if (finished && state.macKey && state.ti) {
      const chip = { macKey: Buffer.from(state.macKey, 'hex'), ti: Buffer.from(state.ti, 'hex') };
      const steps: [ApduKind, number][] = [['sdm', 0], ['key1', 1], ['key2', 2]];
      for (const [kind, counter] of steps) {
        const reply = answer(kind);
        if (!reply) throw new BandRefused([HOLD_STILL]);
        if (statusOf(reply) === '911E' && kind !== 'sdm') {
          // That key was already Bytspot's from a run that stopped halfway.
          return authWith({ ...carry, changed: [...carry.changed, kind === 'key1' ? KEY_FILE_READ : KEY_META_READ] }, state.key0);
        }
        if (!responseVerified(chip, counter, reply)) throw new BandRefused(["The chip's answer did not check out. Start again"]);
      }
    }
    if (!readBack) throw new BandRefused([HOLD_STILL]);
    const url = readNdefUrl(readBack);
    if (url && parseBandSerial(url) !== serial) throw new BandRefused([`This chip carries another number than ${serial}. Tap ${serial}`]);
    const code = url ? parseSunCode(url) : undefined;
    const tap = code ? verifySun(keys, code) : undefined;
    if (tap && tap.uid !== uid) throw new BandRefused([OTHER_KEYS]);
    if (finished) {
      if (!tap) throw new BandRefused(['The chip did not give a valid code after securing. Ask Bytspot for another']);
      return secure(tap);
    }
    if (tap) return authWith({ ...carry, pending: tap }, 'bytspot');
    const template = ndefTemplate(serial);
    return next({ ...carry, tried: ['factory'] }, ['selectApp', 'selectFile', 'write', 'auth1'], [
      SELECT_APP,
      SELECT_NDEF_FILE,
      writeNdef(template),
      authStart(KEY_APP),
    ]);
  }

  // Step 2, first half: the chip's challenge.
  if (state.sent.includes('auth1')) {
    const first = answer('auth1');
    if (!first) {
      // A link written before turns the free write off: authenticate without writing.
      const write = answer('write');
      if (write && statusOf(write) !== '9000') return authWith(carry, 'factory');
      throw new BandRefused([HOLD_STILL]);
    }
    const reply = authAnswer(key0(state.key0), first);
    if (!reply) throw new BandRefused([HOLD_STILL]);
    return next(carry, ['auth2'], [reply.apdu], { rndA: reply.rndA.toString('hex'), rndB: reply.rndB.toString('hex') });
  }

  // Step 2, second half: authenticated, so step 3.
  if (state.sent.includes('auth2')) {
    const second = answer('auth2');
    if (!second || !state.rndA || !state.rndB) throw new BandRefused([HOLD_STILL]);
    if (statusOf(second) === '91AE') {
      const other: Key0 = state.key0 === 'factory' ? 'bytspot' : 'factory';
      if (!state.tried.includes(other)) {
        const changed = state.pending ? [KEY_FILE_READ, KEY_META_READ] : carry.changed;
        return authWith({ ...carry, pending: undefined, changed }, other);
      }
      // A valid code with the factory key 0: keys 1 and 2 are Bytspot's already.
      if (state.pending && state.key0 === 'bytspot') {
        return authWith({ ...carry, pending: undefined, changed: [KEY_FILE_READ, KEY_META_READ] }, 'factory');
      }
      throw new BandRefused([OTHER_KEYS]);
    }
    const session = authFinish(key0(state.key0), Buffer.from(state.rndA, 'hex'), Buffer.from(state.rndB, 'hex'), second);
    if (!session) throw new BandRefused([HOLD_STILL]);
    if (state.key0 === 'bytspot' && state.pending) return secure(state.pending);
    const old = (keyNo: number, bytspot: Buffer) => (state.changed.includes(keyNo) ? bytspot : FACTORY_KEY);
    const sent: ApduKind[] = ['sdm', 'key1', 'key2'];
    const apdus = [
      enableSdm(session, ndefTemplate(serial)),
      changeKey(session, KEY_FILE_READ, keys.fileKey, old(KEY_FILE_READ, keys.fileKey)),
      changeKey(session, KEY_META_READ, keys.metaKey, old(KEY_META_READ, keys.metaKey)),
    ];
    if (state.key0 === 'factory') {
      sent.push('key0');
      apdus.push(changeKey(session, KEY_APP, keys.appKey, FACTORY_KEY));
    }
    return next({ ...carry, pending: undefined }, [...sent, 'selectApp', 'selectFile', 'read'], [...apdus, SELECT_APP, SELECT_NDEF_FILE, READ_NDEF], {
      macKey: session.macKey.toString('hex'),
      ti: session.ti.toString('hex'),
    });
  }

  throw new BandRefused(['Start again, and tap the same item'], 409);
}
