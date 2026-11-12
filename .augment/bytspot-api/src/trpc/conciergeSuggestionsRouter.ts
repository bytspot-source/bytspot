import { z } from 'zod';
import { config } from '../config';
import { OpenAIProvider } from '../bytt-si/llm';
import { conciergeSuggestionsOkSchema, type ConciergeSuggestionsOk } from '../bytt-si/suggestions';
import { coordinateSchema } from '../services/conciergeDiscovery';
import { createSuggestionPorts, suggestForGuest } from '../services/conciergeSuggestions';
import type { Context } from './context';
import { protectedProcedure, rateLimitMiddleware, router } from './trpc';
import { conciergeRefusal, reserveConciergeModelTurn } from '../services/conciergeAccess';
import { conciergeOpenTo } from './conciergeRouter';
import { conciergePlanOpenTo } from './conciergePlanRouter';

export const conciergeSuggestionsInput = z.object({
  location: coordinateSchema.optional(),
}).strict();

const unavailable = {
  version: 1 as const,
  status: 'unavailable' as const,
  source: null,
  reply: 'Concierge discovery is not enabled yet. You can browse places in Discover.',
  area: null,
  when: null,
  primePath: { status: 'unavailable' as const, confirmableNeeds: [] },
  suggestions: [],
};

export const conciergeSuggestionsOutput = z.discriminatedUnion('status', [
  conciergeSuggestionsOkSchema,
  z.object({
    version: z.literal(1),
    status: z.literal('unavailable'),
    source: z.null(),
    reply: z.string().min(1),
    area: z.null(),
    when: z.null(),
    primePath: z.object({ status: z.literal('unavailable'), confirmableNeeds: z.array(z.string()).max(0) }).strict(),
    suggestions: z.array(z.unknown()).max(0),
  }).strict(),
]);

export interface ConciergeSuggestionsDependencies {
  suggest(ctx: Context, input: z.infer<typeof conciergeSuggestionsInput>, now: Date): Promise<ConciergeSuggestionsOk>;
  now?: () => Date;
}

/**
 * Opening prompts for the concierge. Same pilot gate as concierge.discover.
 * The list is curated on the server. A missing model or location still returns it.
 * Nothing is saved or sent to a model unless a key is set and the guest may use one.
 */
export function createConciergeSuggestionsRouter(deps: ConciergeSuggestionsDependencies) {
  return router({
    suggestions: protectedProcedure
      .use(rateLimitMiddleware({ windowMs: 60_000, max: 30, label: 'concierge-suggestions' }))
      .input(conciergeSuggestionsInput)
      .output(conciergeSuggestionsOutput)
      .query(async ({ ctx, input }) => {
        if (!ctx.user || !conciergeOpenTo(ctx.user.userId)) return unavailable;
        return deps.suggest(ctx, input, deps.now?.() ?? new Date());
      }),
  });
}

/**
 * A model turn only when a key is set, the guest may use it, and the shared
 * daily and global Concierge budgets still have room. Otherwise null: the
 * curated list is used and no provider call is made.
 */
export async function suggestionModelFor(userId: string) {
  if (!config.openaiApiKey) return null;
  const refusal = await conciergeRefusal(userId);
  if (refusal) return null;
  if (!(await reserveConciergeModelTurn(userId))) return null;
  return new OpenAIProvider({ apiKey: config.openaiApiKey, model: config.conciergePlanModel, timeoutMs: 2_000 });
}

/** The plan chip is offered only when concierge.plan can actually run for this guest. */
export async function prepareSuggestion(userId: string): Promise<{ model: Awaited<ReturnType<typeof suggestionModelFor>>; planRouteEnabled: boolean }> {
  const model = await suggestionModelFor(userId);
  return { model, planRouteEnabled: conciergePlanOpenTo(userId) && model !== null };
}

export const conciergeSuggestionsRouter = createConciergeSuggestionsRouter({
  suggest: async (ctx, input, now) => {
    if (!ctx.user) return Promise.reject(new Error('Concierge suggestions require a signed-in guest'));
    const userId = ctx.user.userId;
    const { model, planRouteEnabled } = await prepareSuggestion(userId);
    return suggestForGuest({
      now: now.toISOString(),
      userId,
      latitude: input.location?.lat ?? null,
      longitude: input.location?.lng ?? null,
      planRouteEnabled,
    }, createSuggestionPorts(ctx), model);
  },
});
