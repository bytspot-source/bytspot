import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { firstName, holdingsForGuest, linkSource, type BookingDto } from './bookings';
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
