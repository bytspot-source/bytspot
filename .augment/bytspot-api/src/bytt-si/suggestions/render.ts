import { hourPhrase } from './clock';
import {
  conciergeSuggestionsOkSchema, PLAN_THE_NIGHT_STORY, TYPICAL_NOTE,
  type ConciergeSuggestionsOk, type SuggestionFacts, type SuggestionId, type SuggestionNeed, type SuggestionPick, type TypicalFact,
} from './types';

const KNOWN_NEEDS = new Set<string>(['coffee', 'dining', 'nightlife', 'events']);

/** Second chip from the clock, nudged by needs the guest has actually planned. */
export function contextualPick(facts: SuggestionFacts): SuggestionId {
  const hour = facts.clock.hour;
  if (facts.recentNeeds.includes('coffee') && hour >= 5 && hour < 16) return 'coffee_nearby';
  if (facts.recentNeeds.includes('nightlife') && (hour >= 16 || hour < 5)) return 'drinks_nearby';
  if (hour >= 5 && hour < 11) return 'coffee_nearby';
  if (hour >= 11 && hour < 16) return 'lunch_nearby';
  if (hour >= 16 && hour < 21) return 'dinner_nearby';
  return 'drinks_nearby';
}

/** Curated list used when there is no model, or the model returns nothing usable. Never empty. */
export function fallbackPicks(facts: SuggestionFacts): SuggestionPick[] {
  const third: SuggestionPick = facts.plans[0]
    ? { id: 'share_plan', planId: facts.plans[0].id }
    : facts.planRouteEnabled && facts.primePath.status === 'ok' && facts.primePath.confirmableNeeds.includes('events')
      ? { id: 'plan_a_show', planId: null }
      : { id: 'events_nearby', planId: null };
  return [
    { id: 'plan_the_night', planId: null },
    { id: contextualPick(facts), planId: null },
    third,
  ];
}

export function sanitizePicks(picks: SuggestionPick[], facts: SuggestionFacts): SuggestionPick[] {
  const clean: SuggestionPick[] = [];
  for (const pick of picks) {
    if (pick.id === 'share_plan' && !facts.plans.some((plan) => plan.id === pick.planId)) continue;
    if (pick.id === 'plan_a_show' && !(facts.primePath.status === 'ok' && facts.primePath.confirmableNeeds.includes('events'))) continue;
    if (clean.some((kept) => kept.id === pick.id && kept.planId === pick.planId)) continue;
    clean.push({ id: pick.id, planId: pick.id === 'share_plan' ? pick.planId : null });
  }
  if (!clean.some((pick) => pick.id === 'plan_the_night')) clean.unshift({ id: 'plan_the_night', planId: null });
  for (const extra of fallbackPicks(facts)) {
    if (clean.length >= 3) break;
    if (clean.some((pick) => pick.id === extra.id)) continue;
    clean.push(extra);
  }
  const night = clean.find((pick) => pick.id === 'plan_the_night')!;
  return [night, ...clean.filter((pick) => pick.id !== 'plan_the_night')].slice(0, 3);
}

function safeTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 32);
  if (!clean || /\bbusy right now\b|\blive crowd\b|\bspots left\b/i.test(clean)) return 'your plan';
  return clean;
}

function typicalBlock(category: 'coffee' | 'restaurant' | 'bar' | 'venue', reading: TypicalFact | null, hour: number, nowHour: number) {
  if (!reading || reading.level < 1 || reading.level > 4 || !reading.label.trim()) return null;
  return {
    category, level: reading.level, label: reading.label.trim(), source: 'typical' as const,
    note: TYPICAL_NOTE, hourLabel: hourPhrase(hour, nowHour),
  };
}

const SUBJECT: Record<'coffee' | 'restaurant' | 'bar' | 'venue', string> = {
  coffee: 'Coffee places', restaurant: 'Restaurants', bar: 'Bars', venue: 'Places',
};

function typicalSentence(category: 'coffee' | 'restaurant' | 'bar' | 'venue', reading: TypicalFact | null, hour: number, nowHour: number): string {
  const block = typicalBlock(category, reading, hour, nowHour);
  if (!block) return '';
  return ` ${SUBJECT[category]} are typically ${block.label} ${block.hourLabel}. ${TYPICAL_NOTE}`;
}

function needsFor(id: SuggestionId): SuggestionNeed[] {
  if (id === 'plan_the_night') return ['dining', 'nightlife'];
  if (id === 'plan_a_show') return ['events'];
  return [];
}

function primeFor(needs: SuggestionNeed[], facts: SuggestionFacts) {
  const consulted = facts.primePath.status === 'ok';
  // The note points at concierge.plan. Omit it when that route is off so the chip does not send the guest there.
  const confirmableNeeds = consulted && facts.planRouteEnabled
    ? needs.filter((need) => facts.primePath.confirmableNeeds.includes(need))
    : [];
  const listed = confirmableNeeds.length < 2
    ? confirmableNeeds[0] ?? ''
    : `${confirmableNeeds.slice(0, -1).join(', ')} and ${confirmableNeeds.at(-1)}`;
  const note = confirmableNeeds.length
    ? `Prime Path can feature a confirmable Bytspot stop for ${listed}. That pick is on Concierge plans, not on Discover listings.`
    : null;
  return { consulted, confirmableNeeds, note };
}

function renderOne(pick: SuggestionPick, facts: SuggestionFacts): ConciergeSuggestionsOk['suggestions'][number] {
  const nowHour = facts.clock.hour;
  const area = facts.area.sentence;
  if (pick.id === 'share_plan') {
    const plan = facts.plans.find((item) => item.id === pick.planId)!;
    const title = safeTitle(plan.title);
    return {
      id: 'share_plan', label: `Share ${title}`.slice(0, 40), prompt: `Share ${title}`.slice(0, 200),
      reason: `You already have "${title}". Send one link and everyone's in.`,
      destination: 'share_plan', startsPlan: false, planId: plan.id, typical: null,
      primePath: { consulted: facts.primePath.status === 'ok', confirmableNeeds: [], note: null },
    };
  }
  if (pick.id === 'plan_the_night') {
    const typical = typicalBlock('bar', facts.typical.barNight, facts.nightHour, nowHour);
    return {
      id: 'plan_the_night', label: 'Plan the night', prompt: 'Plan dinner and drinks tonight',
      reason: `${PLAN_THE_NIGHT_STORY} ${area}${typicalSentence('bar', facts.typical.barNight, facts.nightHour, nowHour)}`,
      destination: 'discover', startsPlan: true, planId: null, typical,
      primePath: primeFor(needsFor(pick.id), facts),
    };
  }
  if (pick.id === 'plan_a_show') {
    const typical = typicalBlock('venue', facts.typical.venue, nowHour, nowHour);
    return {
      id: 'plan_a_show', label: 'Plan a show', prompt: 'Plan a show tonight',
      reason: `Plan a show, then send one link so everyone's in. ${area}${typicalSentence('venue', facts.typical.venue, nowHour, nowHour)}`,
      destination: facts.planRouteEnabled ? 'concierge_plan' : 'discover',
      startsPlan: true, planId: null, typical,
      primePath: primeFor(['events'], facts),
    };
  }
  const single: Record<Exclude<SuggestionId, 'plan_the_night' | 'plan_a_show' | 'share_plan'>, {
    label: string; prompt: string; category: 'coffee' | 'restaurant' | 'bar' | 'venue'; reading: TypicalFact | null;
  }> = {
    coffee_nearby: { label: 'Coffee nearby', prompt: 'Coffee nearby', category: 'coffee', reading: facts.typical.coffee },
    lunch_nearby: { label: 'Lunch nearby', prompt: 'Lunch nearby', category: 'restaurant', reading: facts.typical.restaurant },
    dinner_nearby: { label: 'Dinner nearby', prompt: 'Dinner nearby', category: 'restaurant', reading: facts.typical.restaurant },
    drinks_nearby: { label: 'Drinks nearby', prompt: 'Drinks nearby', category: 'bar', reading: facts.typical.bar },
    events_nearby: { label: 'Something to do', prompt: 'Events nearby', category: 'venue', reading: facts.typical.venue },
  };
  const spec = single[pick.id];
  const typical = typicalBlock(spec.category, spec.reading, nowHour, nowHour);
  return {
    id: pick.id, label: spec.label, prompt: spec.prompt,
    reason: `${spec.label}. ${area}${typicalSentence(spec.category, spec.reading, nowHour, nowHour)}`,
    destination: 'discover', startsPlan: false, planId: null, typical,
    primePath: { consulted: facts.primePath.status === 'ok', confirmableNeeds: [], note: null },
  };
}

export function renderSuggestions(picks: SuggestionPick[], facts: SuggestionFacts, source: 'si' | 'curated'): ConciergeSuggestionsOk {
  const suggestions = sanitizePicks(picks, facts).map((pick) => renderOne(pick, facts));
  return conciergeSuggestionsOkSchema.parse({
    version: 1, status: 'ok', source, reply: null,
    area: facts.area,
    when: { timezone: 'America/New_York', ...facts.clock },
    primePath: {
      status: facts.primePath.status,
      confirmableNeeds: facts.primePath.status === 'ok' ? facts.primePath.confirmableNeeds : [],
    },
    suggestions,
  });
}

export function knownRecentNeeds(needs: string[]): string[] {
  const kept: string[] = [];
  for (const need of needs) {
    const normalized = need.trim().toLowerCase();
    if (!KNOWN_NEEDS.has(normalized) || kept.includes(normalized)) continue;
    kept.push(normalized);
  }
  return kept.slice(0, 6);
}
