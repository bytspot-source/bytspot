import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../lib/db';
import { newPassCode, PASS_LENGTH } from './bookings';
import { liveCardsAt, type InventoryCard } from './inventory';
import { windowTemplate } from './windows';

/**
 * QR / NFC patches and partner links.
 *
 * A patch is a link printed as a QR code or written to an NFC tag. Opening it
 * shows one place in Bytspot (or one service there) so the guest can send a
 * request. A partner link is the same thing handed to another business that
 * sends guests, such as a hotel front desk: Bytspot counts the scans, requests
 * and bookings that arrive through it, and moves no money.
 */

export const PATCH_KINDS = ['patch', 'partner'] as const;
export type PatchKind = (typeof PATCH_KINDS)[number];

const CODE_ALPHABET = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/;

export const patchInput = z.object({
  kind: z.enum(PATCH_KINDS).default('patch'),
  locationId: z.string().trim().min(1).max(64),
  windowId: z.string().trim().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(60),
  partnerName: z.string().trim().min(1).max(80).optional(),
});
export type PatchInput = z.infer<typeof patchInput>;

export function patchKind(raw: unknown): PatchKind {
  return raw === 'partner' ? 'partner' : 'patch';
}

/** The code from a typed value or the last path segment of a patch link. */
export function normalizePatchCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return value.length === PASS_LENGTH && CODE_ALPHABET.test(value) ? value : undefined;
}

/** What is printed on the QR code and written to the tag. */
export function patchUrl(code: string): string {
  return `${config.frontendUrl.replace(/\/$/, '')}/at/${code}`;
}

export class PatchRefused extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join('; '));
  }
}

export interface PatchStats {
  asks: number;
  bookings: number;
  bookedCents: number;
}

export interface PatchDto {
  id: string;
  kind: PatchKind;
  code: string;
  url: string;
  label: string;
  partnerName: string | null;
  locationId: string;
  place: string;
  windowId: string | null;
  service: string | null;
  scans: number;
  lastScannedAt: string | null;
  createdAt: string;
  asks: number;
  bookings: number;
  bookedCents: number;
}

type PatchRow = Prisma.VendorPatchGetPayload<{
  include: {
    location: { select: { label: true } };
    window: { select: { skuTemplateId: true; title: true; durationMins: true } };
  };
}>;

export function toPatchDto(row: PatchRow, stats: PatchStats = { asks: 0, bookings: 0, bookedCents: 0 }): PatchDto {
  return {
    id: row.id,
    kind: patchKind(row.kind),
    code: row.code,
    url: patchUrl(row.code),
    label: row.label,
    partnerName: row.partnerName,
    locationId: row.locationId,
    place: row.location.label,
    windowId: row.windowId,
    service: row.window ? row.window.title?.trim() || windowTemplate(row.window)?.title || null : null,
    scans: row.scans,
    lastScannedAt: row.lastScannedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...stats,
  };
}

const PATCH_INCLUDE = {
  location: { select: { label: true } },
  window: { select: { skuTemplateId: true, title: true, durationMins: true } },
} as const;

/** What each patch has brought in: requests raised through it, and the bookings they became. */
async function statsFor(patchIds: string[]): Promise<Map<string, PatchStats>> {
  const stats = new Map<string, PatchStats>(patchIds.map((id) => [id, { asks: 0, bookings: 0, bookedCents: 0 }]));
  if (!patchIds.length) return stats;

  const asks = await db.demand.groupBy({
    by: ['viaPatchId'],
    where: { viaPatchId: { in: patchIds } },
    _count: { _all: true },
  });
  for (const row of asks) {
    const entry = row.viaPatchId ? stats.get(row.viaPatchId) : undefined;
    if (entry) entry.asks = row._count._all;
  }

  const booked = await db.offer.findMany({
    where: { state: 'ACCEPTED', demand: { viaPatchId: { in: patchIds } } },
    select: { priceCents: true, demand: { select: { viaPatchId: true } } },
  });
  for (const row of booked) {
    const entry = row.demand.viaPatchId ? stats.get(row.demand.viaPatchId) : undefined;
    if (!entry) continue;
    entry.bookings += 1;
    entry.bookedCents += row.priceCents;
  }
  return stats;
}

export async function listPatches(sellerId: string, kind: PatchKind): Promise<PatchDto[]> {
  const rows = await db.vendorPatch.findMany({
    where: { sellerId, kind, archivedAt: null },
    include: PATCH_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  const stats = await statsFor(rows.map((row) => row.id));
  return rows.map((row) => toPatchDto(row, stats.get(row.id)));
}

/** The refusals that need no database: a partner link names the partner. */
export function patchInputBlockers(input: PatchInput): string[] {
  const blockers: string[] = [];
  if (input.kind === 'partner' && !input.partnerName) blockers.push('Name the partner');
  return blockers;
}

export async function createPatch(sellerId: string, seatId: string, input: PatchInput): Promise<PatchDto> {
  const blockers = patchInputBlockers(input);
  if (blockers.length) throw new PatchRefused(blockers);

  const location = await db.vendorLocation.findFirst({
    where: { id: input.locationId, sellerId, state: { not: 'CLOSED' } },
    select: { id: true },
  });
  if (!location) throw new PatchRefused(['Choose one of your places']);

  if (input.windowId) {
    const window = await db.vendorAvailabilityWindow.findFirst({
      where: { id: input.windowId, sellerId, locationId: location.id },
      select: { id: true },
    });
    if (!window) throw new PatchRefused(['That service is not at this place']);
  }

  // A collision is one in ~10^12; retrying is cheaper than a lookup per draw.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = await db.vendorPatch.create({
        data: {
          sellerId,
          locationId: location.id,
          windowId: input.windowId ?? null,
          code: newPassCode(),
          kind: input.kind,
          label: input.label,
          partnerName: input.kind === 'partner' ? (input.partnerName ?? null) : null,
          createdBySeatId: seatId,
        },
        include: PATCH_INCLUDE,
      });
      return toPatchDto(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new Error('Could not issue a unique patch code');
}

/** Retired patches stop opening anything; the rows stay so past requests keep their source. */
export async function archivePatch(sellerId: string, id: string, kind: PatchKind): Promise<boolean> {
  const { count } = await db.vendorPatch.updateMany({
    where: { id, sellerId, kind, archivedAt: null },
    data: { archivedAt: new Date() },
  });
  return count === 1;
}

export interface OpenedPatch {
  code: string;
  sellerName: string;
  place: { label: string; address: string | null; lat: number; lng: number };
  /** The service the patch names comes first; the rest of the place follows. */
  cards: InventoryCard[];
}

/**
 * What a guest sees after scanning. Undefined for an unknown or retired code,
 * or a place that is not live, so a stale sticker reads as "not found".
 */
export async function openPatch(rawCode: unknown, now: Date = new Date()): Promise<OpenedPatch | undefined> {
  const code = normalizePatchCode(rawCode);
  if (!code) return undefined;
  const patch = await db.vendorPatch.findFirst({
    where: { code, archivedAt: null, seller: { state: 'ACTIVE' }, location: { state: 'ACTIVE' } },
    select: {
      id: true,
      windowId: true,
      locationId: true,
      seller: { select: { legalName: true } },
      location: { select: { label: true, address: true, lat: true, lng: true } },
    },
  });
  if (!patch) return undefined;

  await db.vendorPatch.update({
    where: { id: patch.id },
    data: { scans: { increment: 1 }, lastScannedAt: now },
  });

  const cards = await liveCardsAt(patch.locationId, now);
  const named = cards.findIndex((card) => card.windowId === patch.windowId);
  if (named > 0) cards.unshift(...cards.splice(named, 1));

  return {
    code,
    sellerName: patch.seller.legalName ?? patch.location.label,
    place: patch.location,
    cards,
  };
}

/** The patch a request arrived through, if it belongs to the business being asked. */
export async function patchForAsk(rawCode: unknown, sellerId: string): Promise<string | undefined> {
  const code = normalizePatchCode(rawCode);
  if (!code) return undefined;
  const patch = await db.vendorPatch.findFirst({
    where: { code, sellerId, archivedAt: null },
    select: { id: true },
  });
  return patch?.id;
}
