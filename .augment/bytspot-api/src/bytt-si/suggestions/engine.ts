import type { LLMProvider } from '../llm/types';
import type { ChatMessage } from '../llm/types';
import { classifyArea } from './area';
import { atlantaClock, nightPlanHour } from './clock';
import { SUGGESTIONS_PROMPT } from './prompt/index';
import { fallbackPicks, knownRecentNeeds, renderSuggestions, sanitizePicks } from './render';
import { runSuggestionSkill, suggestionToolDefinitions } from './skills';
import {
  suggestionPicksSchema,
  type ConciergeSuggestionsOk, type SuggestionFacts, type SuggestionPick, type SuggestionPorts,
} from './types';

export interface SuggestionRequest {
  now: string;
  userId: string | null;
  latitude: number | null;
  longitude: number | null;
  /** concierge.plan is open for this guest. Chips that need it stay on Discover when this is false. */
  planRouteEnabled: boolean;
}

export interface SuggestionEngineOptions {
  /** Null when no model is configured or the guest has not agreed to one. The curated list is used. */
  llm: LLMProvider | null;
  ports: SuggestionPorts;
  systemPrompt?: string;
  maxSteps?: number;
  /** Model budget after facts are loaded. Past it, the curated list is returned. */
  deadlineMs?: number;
}

const TYPICAL_KEYS = [
  ['coffee', 'coffee', 'now'],
  ['restaurant', 'restaurant', 'now'],
  ['bar', 'bar', 'now'],
  ['barNight', 'bar', 'night'],
  ['venue', 'venue', 'now'],
] as const;

async function settle<T>(work: Promise<T>, fallback: T): Promise<T> {
  try { return await work; } catch { return fallback; }
}

export async function loadSuggestionFacts(request: SuggestionRequest, ports: SuggestionPorts): Promise<SuggestionFacts> {
  const now = new Date(request.now);
  const clock = atlantaClock(now);
  const nightHour = nightPlanHour(clock.hour);
  const location = request.latitude !== null && request.longitude !== null
    ? { lat: request.latitude, lng: request.longitude } : null;
  const [plans, recentNeeds, primePath, typicalRows] = await Promise.all([
    request.userId ? settle(ports.upcomingPlans(request.userId, now), []) : Promise.resolve([]),
    request.userId ? settle(ports.recentNeeds(request.userId, now), []) : Promise.resolve([]),
    settle(ports.primePath({
      userId: request.userId, latitude: request.latitude, longitude: request.longitude, now: request.now,
    }), { status: 'unavailable' as const, confirmableNeeds: [] }),
    Promise.all(TYPICAL_KEYS.map(([, category, which]) => settle(
      ports.typical({ hour: which === 'night' ? nightHour : clock.hour, dayOfWeek: clock.dayOfWeek, category }),
      null,
    ))),
  ]);
  const typical: SuggestionFacts['typical'] = {
    coffee: null, restaurant: null, bar: null, barNight: null, venue: null,
  };
  TYPICAL_KEYS.forEach(([key], index) => { typical[key] = typicalRows[index]; });
  return {
    now: request.now, userId: request.userId, planRouteEnabled: request.planRouteEnabled,
    clock, area: classifyArea(location), plans: plans.filter((plan) => plan.id && plan.title.trim()),
    recentNeeds: knownRecentNeeds(recentNeeds), typical, nightHour,
    primePath: primePath.status === 'ok' ? primePath : { status: 'unavailable', confirmableNeeds: [] },
  };
}

/**
 * Opening prompts. One system prompt, four skills, a swappable model.
 * The curated list is returned whenever the model is absent, late, or unusable,
 * including when the guest shared no location.
 */
export class SuggestionEngine {
  private readonly llm: LLMProvider | null;
  private readonly ports: SuggestionPorts;
  private readonly system: string;
  private readonly maxSteps: number;
  private readonly deadlineMs: number;

  constructor(options: SuggestionEngineOptions) {
    this.llm = options.llm;
    this.ports = options.ports;
    this.system = options.systemPrompt ?? SUGGESTIONS_PROMPT;
    this.maxSteps = options.maxSteps ?? 3;
    this.deadlineMs = options.deadlineMs ?? 2_500;
  }

  async suggest(request: SuggestionRequest): Promise<ConciergeSuggestionsOk> {
    const facts = await loadSuggestionFacts(request, this.ports);
    const curated = () => renderSuggestions(fallbackPicks(facts), facts, 'curated');
    if (!this.llm) return curated();
    try {
      const picks = await this.ask(facts);
      if (!picks) return curated();
      return renderSuggestions(sanitizePicks(picks, facts), facts, 'si');
    } catch {
      return curated();
    }
  }

  private async ask(facts: SuggestionFacts): Promise<SuggestionPick[] | null> {
    const llm = this.llm;
    if (!llm) return null;
    const context = { facts };
    const tools = suggestionToolDefinitions();
    const messages: ChatMessage[] = [
      { role: 'system', content: this.system },
      { role: 'user', content: 'Choose opening prompts for this guest. Call skills for the facts. Do not name venues.' },
    ];
    const started = Date.now();
    for (let step = 0; step < this.maxSteps; step += 1) {
      if (Date.now() - started >= this.deadlineMs) return null;
      const reply = await llm.chat({ messages, tools, toolChoice: 'auto' });
      if (!reply.toolCalls.length) break;
      messages.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        messages.push({
          role: 'tool', toolCallId: call.id, name: call.name,
          content: await runSuggestionSkill(call.name, call.arguments, context),
        });
      }
    }
    if (Date.now() - started >= this.deadlineMs) return null;
    const picked = await llm.structured({
      name: 'suggestion_picks', schema: suggestionPicksSchema,
      messages: [
        ...messages,
        { role: 'user', content: 'Return suggestion_picks now. Include plan_the_night. planId is null except for share_plan.' },
      ],
    });
    return picked.picks;
  }
}
