import { z } from 'zod';
import { db } from '../lib/db';
import { BOOKABLE_TEMPLATES } from './contract';
import { availabilityDefaultsFor, deriveSlots, type DerivedSlot, type SlotState } from './availability';
import { NotFound } from './demandFeed';
import { WindowRefused, windowDto, type WindowDto } from './windows';

/**
 * The Availability tab against real windows. Slots are still derived, never
 * stored: blocking or closing one writes the same commitment row a booking
 * would, keyed on the window and the instant.
 */

export type SlotOperationId = 'OPEN_SLOT' | 'CLOSE_SLOT' | 'BLOCK_SLOT';

const availability = BOOKABLE_TEMPLATES.availability as unknown as {
  operations: { id: string; from: SlotState[]; to: SlotState }[];
  blockReasons: string[];
};
const operations = availability.operations;

export const BLOCK_REASONS = availability.blockReasons;
const MAX_QUANTITY = BOOKABLE_TEMPLATES.availability.defaults.maxQuantityPerSlot;

export const slotWrite = z.object({
  startsAt: z.string().datetime(),
  operation: z.enum(['OPEN_SLOT', 'CLOSE_SLOT', 'BLOCK_SLOT']),
  reason: z.string().max(40).optional(),
});

export const scheduleWrite = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  openMins: z.number().int().min(0).max(1440),
  closeMins: z.number().int().min(0).max(1440),
  quantity: z.number().int().min(1).max(MAX_QUANTITY),
});

/** Whether the contract lets this operation run on a slot in this state. */
export function slotOperationAllowed(operation: SlotOperationId, state: SlotState): boolean {
  return operations.find((entry) => entry.id === operation)?.from.includes(state) ?? false;
}

/** The commitment flags an operation leaves behind. Bookings already taken are never touched. */
export function commitmentFlags(operation: SlotOperationId): { blocked: boolean; closed: boolean } {
  if (operation === 'CLOSE_SLOT') return { blocked: false, closed: true };
  if (operation === 'BLOCK_SLOT') return { blocked: true, closed: false };
  return { blocked: false, closed: false };
}

/** What stops a schedule edit. `busiest` is the most any future slot has already sold. */
export function scheduleBlockers(input: z.infer<typeof scheduleWrite>, domain: string, busiest: number): string[] {
  const blockers: string[] = [];
  if (input.closeMins <= input.openMins) blockers.push('Closing has to come after opening');
  else {
    const { slotKind, slotMinutes } = availabilityDefaultsFor(domain);
    if (slotKind === 'rolling' && input.closeMins - input.openMins < slotMinutes) {
      blockers.push(`Open for at least ${slotMinutes} minutes`);
    }
  }
  if (input.quantity < busiest) blockers.push(`${busiest} already booked in one slot, so keep at least ${busiest}`);
  return blockers;
}

export interface SlotDto {
  startsAt: string;
  startMins: number;
  weekday: number;
  state: SlotState;
  quantity: number;
  committed: number;
  remaining: number;
}

function slotDto(slot: DerivedSlot): SlotDto {
  return {
    startsAt: slot.startsAt.toISOString(),
    startMins: slot.startMins,
    weekday: slot.weekday,
    state: slot.state,
    quantity: slot.quantity,
    committed: slot.committed,
    remaining: slot.remaining,
  };
}

async function loadWindow(sellerId: string, windowId: string) {
  const window = await db.vendorAvailabilityWindow.findFirst({
    where: { id: windowId, sellerId },
    include: { location: true, commitments: true, media: { where: { kind: 'cover' }, select: { id: true, kind: true } } },
  });
  if (!window) throw new NotFound('offering');
  return window;
}

export interface WindowSlots {
  window: WindowDto;
  timezone?: string;
  slots: SlotDto[];
}

export async function windowSlots(sellerId: string, windowId: string, now: Date = new Date()): Promise<WindowSlots> {
  const window = await loadWindow(sellerId, windowId);
  const slots = deriveSlots({ window, timeZone: window.location.timezone, commitments: window.commitments, now });
  return { window: windowDto(window), timezone: window.location.timezone ?? undefined, slots: slots.map(slotDto) };
}

export async function moveSlot(input: {
  sellerId: string;
  windowId: string;
  startsAt: Date;
  operation: SlotOperationId;
  reason?: string;
  now?: Date;
}): Promise<WindowSlots> {
  const now = input.now ?? new Date();
  const window = await loadWindow(input.sellerId, input.windowId);
  const slots = deriveSlots({ window, timeZone: window.location.timezone, commitments: window.commitments, now });
  // Only an instant the window actually produces; anything else would be a
  // commitment that never lines up with a slot.
  const slot = slots.find((entry) => entry.startsAt.getTime() === input.startsAt.getTime());
  if (!slot) throw new WindowRefused(['That time is not one of this bookable\'s slots']);
  if (!slotOperationAllowed(input.operation, slot.state)) {
    throw new WindowRefused([`A ${slot.state.toLowerCase()} slot cannot do that`]);
  }
  const reason = input.operation === 'BLOCK_SLOT' && input.reason && BLOCK_REASONS.includes(input.reason) ? input.reason : null;
  const flags = commitmentFlags(input.operation);
  await db.vendorSlotCommitment.upsert({
    where: { windowId_startsAt: { windowId: window.id, startsAt: slot.startsAt } },
    create: { windowId: window.id, startsAt: slot.startsAt, ...flags, blockReason: reason },
    update: { ...flags, blockReason: reason },
  });
  return windowSlots(input.sellerId, input.windowId, now);
}

export async function updateSchedule(input: {
  sellerId: string;
  windowId: string;
  schedule: z.infer<typeof scheduleWrite>;
  now?: Date;
}): Promise<WindowSlots> {
  const now = input.now ?? new Date();
  const window = await loadWindow(input.sellerId, input.windowId);
  const busiest = window.commitments
    .filter((commitment) => commitment.startsAt.getTime() > now.getTime())
    .reduce((max, commitment) => Math.max(max, commitment.committed), 0);
  const blockers = scheduleBlockers(input.schedule, window.domain, busiest);
  if (blockers.length) throw new WindowRefused(blockers);
  await db.vendorAvailabilityWindow.update({
    where: { id: window.id },
    data: {
      weekdays: [...new Set(input.schedule.weekdays)].sort((a, b) => a - b),
      openMins: input.schedule.openMins,
      closeMins: input.schedule.closeMins,
      quantity: input.schedule.quantity,
    },
  });
  return windowSlots(input.sellerId, input.windowId, now);
}
