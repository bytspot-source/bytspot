import { z } from 'zod';
import type { VendorAvailabilityWindow, VendorLocation } from '@prisma/client';
import { db } from '../lib/db';
import { availabilityDefaultsFor } from './availability';
import { BOOKABLE_TEMPLATES, locationCanPublish, type LocationState, type SellerState } from './contract';
import { coverUrlFor } from './media';
import { timezoneAt } from './geocode';
import { NotFound } from './demandFeed';

/**
 * A real bookable: a SKU template sold from one PIN on a weekly shape.
 *
 * Created as a draft (`active: false`) so a seller can hang a cover on it
 * before any guest or demand feed can see it. Publishing is the only way a
 * window becomes visible, and publishing is where the business, the place
 * and the window are all held to the catalog at once.
 */

export interface SkuTemplate {
  id: string;
  domain: string;
  title: string;
  category: string;
  discoverType: string;
  priceCents: number;
  maxGuests: number;
  durationMins: number;
  capabilities: string[];
}

const TEMPLATES = BOOKABLE_TEMPLATES.templates as SkuTemplate[];
const MAX_QUANTITY = BOOKABLE_TEMPLATES.availability.defaults.maxQuantityPerSlot;
const MINUTES_PER_DAY = 1440;

export function skuTemplate(id: string): SkuTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}

const CUSTOM_PREFIX = 'custom.';
const DOMAINS = BOOKABLE_TEMPLATES.domains as { id: string; label: string; variants: string[] }[];

/** `custom.<domain>.<variant>`: a variant the catalog names but prints no preset for. */
export function isCustomTemplateId(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/**
 * The stand-in template for a blank window. Only a domain and variant the
 * catalog already lists resolve, so a blank adds a name and a price, never a
 * noun. Category, rail and party size are borrowed from the domain's first
 * printed preset, so a blank lands on the same Discover rail as its siblings.
 */
export function customTemplate(id: string): SkuTemplate | undefined {
  if (!isCustomTemplateId(id)) return undefined;
  const [domainId, variant, ...rest] = id.slice(CUSTOM_PREFIX.length).split('.');
  if (rest.length || !domainId || !variant) return undefined;
  const domain = DOMAINS.find((entry) => entry.id === domainId);
  if (!domain?.variants.includes(variant)) return undefined;
  const sibling = TEMPLATES.find((template) => template.domain === domainId);
  return {
    id,
    domain: domainId,
    title: variant.replace(/-/g, ' ').replace(/^./, (char) => char.toUpperCase()),
    category: sibling?.category ?? domain.label,
    discoverType: sibling?.discoverType ?? domainId,
    priceCents: 0,
    maxGuests: sibling?.maxGuests ?? 2,
    durationMins: availabilityDefaultsFor(domainId).slotMinutes,
    capabilities: sibling?.capabilities ?? ['BOOK', 'CANCEL'],
  };
}

/** A catalog preset or a blank; anything else is not something Bytspot sells. */
export function resolveTemplate(id: string): SkuTemplate | undefined {
  return skuTemplate(id) ?? customTemplate(id);
}

/** What a window is called and how long it runs: the seller's words first, then the template's. */
export function windowTemplate(
  window: Pick<VendorAvailabilityWindow, 'skuTemplateId'> & { title?: string | null; durationMins?: number | null },
): SkuTemplate | undefined {
  const template = resolveTemplate(window.skuTemplateId);
  if (!template) return undefined;
  return {
    ...template,
    title: window.title?.trim() || template.title,
    durationMins: window.durationMins ?? template.durationMins,
  };
}

export const createWindowInput = z.object({
  skuTemplateId: z.string().min(1).max(120),
  locationId: z.string().min(1).max(64),
  /** 0 = Sunday, matching how slots are derived. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  openMins: z.number().int().min(0).max(MINUTES_PER_DAY),
  closeMins: z.number().int().min(0).max(MINUTES_PER_DAY),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
  priceCents: z.number().int().min(0).max(10_000_000).optional(),
  maxGuests: z.number().int().min(1).max(500).optional(),
  title: z.string().trim().max(80).optional(),
  durationMins: z.number().int().min(5).max(MINUTES_PER_DAY).optional(),
});
export type CreateWindowInput = z.infer<typeof createWindowInput>;

/** What is wrong with a window before it is written. Empty means it may be saved. */
export function windowBlockers(
  input: CreateWindowInput,
  template: SkuTemplate | undefined,
  location: Pick<VendorLocation, 'state'> | undefined,
): string[] {
  const blockers: string[] = [];
  if (!template) blockers.push('That is not something Bytspot sells yet');
  else if (isCustomTemplateId(template.id)) {
    // A blank has no preset to borrow a name or a price from.
    if (!input.title?.trim()) blockers.push('Give it a name guests will see');
    if (input.priceCents === undefined) blockers.push('Set a price');
  }
  if (!location) blockers.push('Choose one of your places');
  else if (location.state === 'CLOSED') blockers.push('That place is closed');
  if (input.closeMins <= input.openMins) blockers.push('Closing has to come after opening');
  else if (template) {
    const { slotKind, slotMinutes } = availabilityDefaultsFor(template.domain);
    if (slotKind === 'rolling' && input.closeMins - input.openMins < slotMinutes) {
      blockers.push(`Open for at least ${slotMinutes} minutes`);
    }
  }
  return blockers;
}

/**
 * What stands between a draft and a guest. Each one is a thing the seller can
 * go and fix, so the console reads this as a checklist rather than a refusal.
 */
export function publishBlockers(input: {
  sellerState: SellerState;
  locationState: LocationState;
  timezone: string | null;
  skuTemplateId: string;
}): string[] {
  const blockers: string[] = [];
  if (input.sellerState !== 'ACTIVE') blockers.push('Your business has to be approved first');
  if (!locationCanPublish(input.locationState)) blockers.push('Activate this place first');
  // Without a zone no slot can be derived, so a published window would sell nothing.
  if (!input.timezone) blockers.push('This place needs a time zone');
  if (!resolveTemplate(input.skuTemplateId)) blockers.push('That is not something Bytspot sells yet');
  return blockers;
}

export interface WindowDto {
  id: string;
  skuTemplateId: string;
  title: string;
  domain: string;
  locationId: string;
  weekdays: number[];
  openMins: number;
  closeMins: number;
  quantity: number;
  priceCents: number;
  maxGuests: number;
  durationMins: number;
  intent: string;
  published: boolean;
  coverUrl?: string;
}

export function windowDto(
  window: VendorAvailabilityWindow & { media?: { id: string; kind: string }[] },
): WindowDto {
  return {
    id: window.id,
    skuTemplateId: window.skuTemplateId,
    title: windowTemplate(window)?.title ?? window.skuTemplateId,
    domain: window.domain,
    locationId: window.locationId,
    weekdays: window.weekdays,
    openMins: window.openMins,
    closeMins: window.closeMins,
    quantity: window.quantity,
    priceCents: window.priceCents,
    maxGuests: window.maxGuests,
    durationMins: windowTemplate(window)?.durationMins ?? window.slotMinutes,
    intent: window.intent,
    published: window.active,
    coverUrl: coverUrlFor(window.media ?? []),
  };
}

export class WindowRefused extends Error {
  constructor(readonly blockers: string[]) {
    super('window refused');
  }
}

export async function listWindows(sellerId: string, bookableIds?: string[]): Promise<WindowDto[]> {
  const rows = await db.vendorAvailabilityWindow.findMany({
    where: { sellerId, ...(bookableIds ? { id: { in: bookableIds } } : {}) },
    include: { media: { where: { kind: 'cover' }, select: { id: true, kind: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(windowDto);
}

/**
 * Always a draft. Price, party size, name and length fall back to the template,
 * never to zero; a blank has no template price, so windowBlockers requires one.
 */
export async function createWindow(
  sellerId: string,
  locations: Pick<VendorLocation, 'id' | 'state'>[],
  input: CreateWindowInput,
): Promise<WindowDto> {
  const template = resolveTemplate(input.skuTemplateId);
  const location = locations.find((entry) => entry.id === input.locationId);
  const blockers = windowBlockers(input, template, location);
  if (blockers.length || !template) throw new WindowRefused(blockers);

  const defaults = availabilityDefaultsFor(template.domain);
  const row = await db.vendorAvailabilityWindow.create({
    data: {
      sellerId,
      locationId: input.locationId,
      skuTemplateId: template.id,
      domain: template.domain,
      slotKind: defaults.slotKind,
      slotMinutes: defaults.slotMinutes,
      leadTimeMins: defaults.leadTimeMins,
      horizonDays: defaults.horizonDays,
      weekdays: [...new Set(input.weekdays)].sort((a, b) => a - b),
      openMins: input.openMins,
      closeMins: input.closeMins,
      quantity: input.quantity,
      priceCents: input.priceCents ?? template.priceCents,
      maxGuests: input.maxGuests ?? template.maxGuests,
      title: input.title?.trim() || null,
      durationMins: input.durationMins ?? null,
      active: false,
    },
  });
  return windowDto(row);
}

/**
 * Scoped to the caller's seller, so another business's window is not found
 * rather than forbidden.
 */
export async function setWindowPublished(input: {
  sellerId: string;
  sellerState: SellerState;
  windowId: string;
  published: boolean;
}): Promise<WindowDto> {
  const window = await db.vendorAvailabilityWindow.findFirst({
    where: { id: input.windowId, sellerId: input.sellerId },
    include: { location: true, media: { where: { kind: 'cover' }, select: { id: true, kind: true } } },
  });
  if (!window) throw new NotFound('offering');

  if (input.published) {
    // A place saved before its zone was looked up is filled in here rather than
    // sent back to the vendor for something they never chose.
    let timezone = window.location.timezone;
    if (!timezone) {
      timezone = (await timezoneAt(window.location.lat, window.location.lng)) ?? null;
      if (timezone) await db.vendorLocation.update({ where: { id: window.location.id }, data: { timezone } });
    }
    const blockers = publishBlockers({
      sellerState: input.sellerState,
      locationState: window.location.state as LocationState,
      timezone,
      skuTemplateId: window.skuTemplateId,
    });
    if (blockers.length) throw new WindowRefused(blockers);
  }

  const row = await db.vendorAvailabilityWindow.update({
    where: { id: window.id },
    data: { active: input.published },
    include: { media: { where: { kind: 'cover' }, select: { id: true, kind: true } } },
  });
  return windowDto(row);
}
