import { z } from 'zod';
import { db } from '../lib/db';
import { NotFound } from './demandFeed';

/**
 * A seller saying what a window is for.
 *
 * The rest of the platform infers capability from the shape of a seller's
 * data — a party means book, a coffee reservation means request. This is the
 * seller stating it instead, and the platform holding them to it.
 *
 * Only words whose rail exists may be said. `request` is the whole vocabulary
 * today because ask → offer → accept is the only loop that is built; `none` is
 * the other half of a gate, so that declining does not require deleting a
 * window. `book`, `order` and `redirect` are refused here and refused again by
 * the CHECK constraint, because a promise the platform cannot keep must not be
 * storable merely because a route was careless.
 */

export const WINDOW_INTENTS = ['request', 'none'] as const;
export type WindowIntent = (typeof WINDOW_INTENTS)[number];

export const setIntentInput = z.object({
  intent: z.enum(WINDOW_INTENTS),
});

export interface IntentResult {
  windowId: string;
  intent: WindowIntent;
  /** What the seller has actually agreed to, in their own words. */
  meaning: string;
}

const MEANING: Record<WindowIntent, string> = {
  request: 'Guests can ask. You answer with an offer, and honour it if they take it.',
  none: 'This window stays as it is, but no asks will reach you.',
};

/**
 * Scoped to the caller's own seller, so a seat cannot reach a window belonging
 * to another business. A window that is not theirs is not found rather than
 * forbidden: the id is not theirs to learn about.
 */
export async function setWindowIntent(input: {
  sellerId: string;
  windowId: string;
  intent: WindowIntent;
}): Promise<IntentResult> {
  const changed = await db.vendorAvailabilityWindow.updateMany({
    where: { id: input.windowId, sellerId: input.sellerId },
    data: { intent: input.intent },
  });
  if (changed.count === 0) throw new NotFound('offering');

  return {
    windowId: input.windowId,
    intent: input.intent,
    meaning: MEANING[input.intent],
  };
}
