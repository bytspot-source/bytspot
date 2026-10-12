import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../lib/db';
import { firstName, ticketForGuest, type BookingDto } from './bookings';

/**
 * Bytspot wristbands.
 *
 * Each band's NFC chip and printed QR code carry bytspot.app/<serial>, for
 * example bytspot.app/BYT424-0301. Bytspot assigns ranges of serials to a
 * business; the business activates each band, choosing the place it admits to
 * and its tier, and marks it lost when it goes missing. A band that is not
 * active opens nothing.
 *
 * At the door a band is linked once to the guest wearing it, from their paid
 * ticket. After that a tap finds the guest's ticket for the day, and checking
 * in is the same single step as for the ticket's barcode.
 */

export const BAND_TIERS = ['green', 'platinum', 'black'] as const;
export type BandTier = (typeof BAND_TIERS)[number];
export type BandState = 'assigned' | 'active' | 'lost';

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
  state: BandState;
  tier: BandTier | null;
  vendorCode: string | null;
  locationId: string | null;
  place: string | null;
  activatedAt: string | null;
  lostAt: string | null;
  /** First name of the guest it is linked to. */
  holder: string | null;
  linkedAt: string | null;
}

const BAND_INCLUDE = { location: { select: { label: true } }, holder: { select: { name: true } } } as const;

type BandRow = Prisma.VendorBandGetPayload<{ include: typeof BAND_INCLUDE }>;

function bandState(raw: string): BandState {
  return raw === 'active' || raw === 'lost' ? raw : 'assigned';
}

function bandTier(raw: string | null): BandTier | null {
  return BAND_TIERS.includes(raw as BandTier) ? (raw as BandTier) : null;
}

export function toBandDto(row: BandRow): BandDto {
  return {
    id: row.id,
    serial: row.serial,
    state: bandState(row.state),
    tier: bandTier(row.tier),
    vendorCode: row.vendorCode,
    locationId: row.locationId,
    place: row.location?.label ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    lostAt: row.lostAt?.toISOString() ?? null,
    holder: row.holderUserId ? (firstName(row.holder?.name) ?? 'Guest') : null,
    linkedAt: row.linkedAt?.toISOString() ?? null,
  };
}

export async function listBands(sellerId: string): Promise<BandDto[]> {
  const rows = await db.vendorBand.findMany({ where: { sellerId }, include: BAND_INCLUDE, orderBy: { serial: 'asc' } });
  return rows.map(toBandDto);
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

export const activateBandInput = z.object({
  /** A band number, or the link its QR code or chip carries. */
  band: z.string().trim().min(1).max(300),
  locationId: z.string().trim().min(1).max(64),
  tier: z.enum(BAND_TIERS),
  vendorCode: vendorCode.optional(),
});
export type ActivateBandInput = z.infer<typeof activateBandInput>;

export const editBandInput = z
  .object({
    locationId: z.string().trim().min(1).max(64).optional(),
    tier: z.enum(BAND_TIERS).optional(),
    /** Null clears it. */
    vendorCode: vendorCode.nullable().optional(),
  })
  .refine((edit) => edit.locationId !== undefined || edit.tier !== undefined || edit.vendorCode !== undefined);
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
  if (!serial) throw new BandRefused(['That is not a Bytspot band number, like BYT424-0301']);

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
        locationId: input.locationId,
        tier: input.tier,
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

/** Changes a band's place, tier or code. A lost band is kept as it was. */
export async function editBand(sellerId: string, id: string, edit: EditBandInput): Promise<BandDto> {
  const band = await db.vendorBand.findFirst({ where: { id, sellerId }, select: { id: true, state: true } });
  if (!band) throw new BandRefused(['That band is not here'], 404);
  if (band.state === 'lost') throw new BandRefused(['A lost band cannot be changed']);
  if (edit.locationId) await requirePlace(sellerId, edit.locationId);
  try {
    const { count } = await db.vendorBand.updateMany({
      where: { id, sellerId, state: { not: 'lost' } },
      data: {
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

/** An active band of this business, or the refusal a door shows for it. */
async function bandAtTheDoor(sellerId: string, raw: string): Promise<BandRow> {
  const serial = parseBandSerial(raw);
  if (!serial) throw new BandRefused(['That is not a Bytspot band number, like BYT424-0301']);
  const band = await db.vendorBand.findFirst({ where: { serial, sellerId }, include: BAND_INCLUDE });
  if (!band) throw new BandRefused([`${serial} is not one of your bands`], 404);
  if (band.state === 'lost') throw new BandRefused([`${serial} was marked lost. Scan the guest's ticket barcode instead`]);
  if (band.state !== 'active') throw new BandRefused([`${serial} is not activated yet. Activate it under Bands`]);
  return band;
}

export interface BandAtDoor {
  band: BandDto;
  /** The linked guest's ticket for now, when they have one. */
  booking?: BookingDto;
}

/** Reads a band without changing anything. Checking in is a separate, explicit step. */
export async function readBand(sellerId: string, raw: string, now: Date = new Date()): Promise<BandAtDoor> {
  const row = await bandAtTheDoor(sellerId, raw);
  const band = toBandDto(row);
  if (!row.holderUserId) return { band };
  const booking = await ticketForGuest({ sellerId, userId: row.holderUserId, locationId: row.locationId, now });
  return booking ? { band, booking } : { band };
}

/**
 * Links a band to the guest who paid for a ticket, so the next tap finds them.
 * Linking it to the same guest again returns it unchanged; a band already
 * worn by someone else is refused.
 */
export async function linkBand(input: { sellerId: string; seatId: string; band: string; bookingId: string; now?: Date }): Promise<BandDto> {
  const row = await bandAtTheDoor(input.sellerId, input.band);
  const order = await db.vendorTicketOrder.findFirst({
    where: { id: input.bookingId, sellerId: input.sellerId, status: 'completed' },
    select: { userId: true, ticket: { select: { locationId: true } } },
  });
  if (!order) throw new BandRefused(["A band links to a paid ticket. Scan the guest's ticket barcode first"], 404);
  if (row.locationId && row.locationId !== order.ticket.locationId) {
    throw new BandRefused([`${row.serial} is for ${row.location?.label ?? 'another place'}. Use a band for this place`]);
  }
  if (row.holderUserId === order.userId) return toBandDto(row);
  if (row.holderUserId) throw new BandRefused([`${row.serial} is linked to another guest. Give this guest a new band`]);

  const { count } = await db.vendorBand.updateMany({
    where: { id: row.id, sellerId: input.sellerId, state: 'active', holderUserId: null },
    data: { holderUserId: order.userId, linkedAt: input.now ?? new Date(), linkedBySeatId: input.seatId },
  });
  const linked = await db.vendorBand.findUniqueOrThrow({ where: { id: row.id }, include: BAND_INCLUDE });
  if (count === 0 && linked.holderUserId !== order.userId) {
    throw new BandRefused([`${row.serial} was just linked to another guest. Give this guest a new band`]);
  }
  return toBandDto(linked);
}
