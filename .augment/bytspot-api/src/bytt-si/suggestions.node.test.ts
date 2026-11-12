import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { proposedPlanNeeds, createConciergeDiscovery } from '../services/conciergeDiscovery';
import { typicalCrowd } from '../services/typicalOccupancy';
import { FakeProvider } from './llm/fake';
import { LAUNCH_MARKET, classifyArea } from './suggestions/area';
import { atlantaClock } from './suggestions/clock';
import { SuggestionEngine } from './suggestions/engine';
import { SUGGESTIONS_PROMPT } from './suggestions/prompt/index';
import { suggestionSkills } from './suggestions/skills';
import { PLAN_THE_NIGHT_STORY, TYPICAL_NOTE, type SuggestionPorts } from './suggestions/types';

const FRIDAY_7_PM = '2026-11-14T00:00:00.000Z';
const FRIDAY_8_AM = '2026-11-13T13:00:00.000Z';
const FRIDAY_2_PM = '2026-11-13T19:00:00.000Z';
const MIDTOWN = { latitude: LAUNCH_MARKET.lat, longitude: LAUNCH_MARKET.lng };

function ports(over: Partial<SuggestionPorts> = {}): SuggestionPorts {
  return {
    upcomingPlans: async () => [],
    recentNeeds: async () => [],
    typical: async ({ hour, dayOfWeek, category }) => {
      const crowd = typicalCrowd(hour, dayOfWeek, category);
      return { level: crowd.level, label: crowd.label };
    },
    primePath: async () => ({ status: 'unavailable', confirmableNeeds: [] }),
    ...over,
  };
}

const base = {
  now: FRIDAY_7_PM, userId: 'guest-1', planRouteEnabled: true,
  latitude: MIDTOWN.latitude, longitude: MIDTOWN.longitude,
};

describe('bytt-si suggestions prompt and skills', () => {
  it('keeps one system prompt, identical to system.md, and names Prime Path plus the skills', () => {
    const md = readFileSync(join(__dirname, 'suggestions', 'prompt', 'system.md'), 'utf8').trim();
    assert.equal(SUGGESTIONS_PROMPT, md);
    assert.match(SUGGESTIONS_PROMPT, /Prime Path/);
    assert.match(SUGGESTIONS_PROMPT, /plan_the_night/);
    for (const name of ['context', 'plans', 'history', 'prime_path']) assert.match(SUGGESTIONS_PROMPT, new RegExp(`- ${name}`));
    assert.deepEqual(suggestionSkills.map((skill) => skill.name), ['context', 'plans', 'history', 'prime_path']);
  });

  it('reads Atlanta local time and only names Midtown from nearby coordinates', () => {
    assert.deepEqual(atlantaClock(new Date(FRIDAY_8_AM)), { hour: 8, dayOfWeek: 5, weekday: 'Fri' });
    assert.equal(atlantaClock(new Date(FRIDAY_7_PM)).hour, 19);
    assert.equal(classifyArea(null).basis, 'launch_market');
    assert.match(classifyArea(null).sentence, /wasn't shared/);
    assert.equal(classifyArea({ lat: LAUNCH_MARKET.lat, lng: LAUNCH_MARKET.lng }).label, 'Midtown');
    assert.equal(classifyArea({ lat: 33.84, lng: -84.38 }).label, 'Atlanta');
    assert.equal(classifyArea({ lat: 40, lng: -75 }).label, null);
  });
});

describe('bytt-si suggestions: curated fallback', () => {
  it('is never empty without a model or a location, labels typical busyness as typical, and starts a Plan', async () => {
    const engine = new SuggestionEngine({ llm: null, ports: ports() });
    const out = await engine.suggest({ ...base, latitude: null, longitude: null });
    assert.equal(out.source, 'curated');
    assert.equal(out.suggestions.length, 3);
    assert.equal(out.suggestions[0].id, 'plan_the_night');
    assert.equal(out.suggestions[0].startsPlan, true);
    assert.equal(out.suggestions[0].destination, 'discover');
    assert.equal(out.suggestions[0].prompt, 'Plan dinner and drinks tonight');
    assert.match(out.suggestions[0].reason, new RegExp(PLAN_THE_NIGHT_STORY.replace(/[.]/g, '\\.')));
    assert.match(out.area.sentence, /wasn't shared/);
    assert.equal(out.suggestions[0].typical?.source, 'typical');
    assert.equal(out.suggestions[0].typical?.note, TYPICAL_NOTE);
    assert.match(out.suggestions[0].reason, /not a live reading/);
    assert.equal(out.suggestions[0].typical?.hourLabel, 'around this hour');
    const blob = JSON.stringify(out);
    assert.doesNotMatch(blob, /busy right now|live crowd|spots left/);
    assert.equal(out.primePath.status, 'unavailable');
    assert.ok(out.suggestions.every((suggestion) => suggestion.primePath.note === null));
    assert.ok(proposedPlanNeeds([out.suggestions[0].prompt]));
  });

  it('follows the hour, the guest\'s history, an upcoming Plan, and a confirmable Prime Path need', async () => {
    const morning = await new SuggestionEngine({ llm: null, ports: ports() }).suggest({ ...base, now: FRIDAY_8_AM });
    assert.equal(morning.suggestions[0].typical?.hourLabel, 'around 10 PM');
    assert.equal(morning.suggestions[1].id, 'coffee_nearby');
    assert.equal(morning.suggestions[1].typical?.category, 'coffee');
    assert.equal(morning.suggestions[2].id, 'events_nearby');

    const remembered = await new SuggestionEngine({ llm: null, ports: ports({ recentNeeds: async () => ['coffee', 'nope'] }) })
      .suggest({ ...base, now: FRIDAY_2_PM });
    assert.equal(remembered.suggestions[1].id, 'coffee_nearby');

    const sharing = await new SuggestionEngine({
      llm: null,
      ports: ports({ upcomingPlans: async () => [{ id: 'plan_1', title: 'Friday Night', startsAt: FRIDAY_7_PM, areaLabel: 'Midtown' }] }),
    }).suggest(base);
    assert.equal(sharing.suggestions[2].destination, 'share_plan');
    assert.equal(sharing.suggestions[2].planId, 'plan_1');
    assert.match(sharing.suggestions[2].reason, /Friday Night/);
    assert.equal(sharing.suggestions[2].startsPlan, false);

    const featured = await new SuggestionEngine({
      llm: null,
      ports: ports({ primePath: async () => ({ status: 'ok', confirmableNeeds: ['events', 'nightlife'] }) }),
    }).suggest(base);
    assert.equal(featured.primePath.status, 'ok');
    assert.deepEqual(featured.primePath.confirmableNeeds, ['events', 'nightlife']);
    assert.equal(featured.suggestions[2].id, 'plan_a_show');
    assert.equal(featured.suggestions[2].destination, 'concierge_plan');
    assert.match(featured.suggestions[2].primePath.note ?? '', /Prime Path/);
    assert.match(featured.suggestions[0].primePath.note ?? '', /nightlife/);
    assert.doesNotMatch(featured.suggestions[0].primePath.note ?? '', /events/);

    const planOff = await new SuggestionEngine({
      llm: null,
      ports: ports({ primePath: async () => ({ status: 'ok', confirmableNeeds: ['events'] }) }),
    }).suggest({ ...base, planRouteEnabled: false });
    assert.equal(planOff.suggestions[2].id, 'events_nearby');
    assert.ok(planOff.suggestions.every((suggestion) => suggestion.primePath.note === null));
  });

  it('the night prompt becomes a Proposed Plan on discover', async () => {
    const out = await new SuggestionEngine({ llm: null, ports: ports() }).suggest(base);
    const prompt = out.suggestions.find((suggestion) => suggestion.startsPlan && suggestion.destination === 'discover')!.prompt;
    let queries: string[] = [];
    const response = await createConciergeDiscovery({
      venues: async () => [],
      places: async (search) => {
        queries.push(search.query);
        const bar = search.query === 'bar';
        return {
          source: 'google',
          places: [{
            placeId: bar ? 'bar' : 'kitchen', name: bar ? 'Real Bar' : 'Real Kitchen', address: '1 Peachtree',
            lat: LAUNCH_MARKET.lat + 0.001, lng: LAUNCH_MARKET.lng, rating: null, ratingCount: 0, priceLevel: null,
            types: [bar ? 'bar' : 'restaurant'], primaryType: bar ? 'bar' : 'restaurant',
            photoUrls: [], photoAttributions: [], isOpen: true, websiteUri: null,
          }],
        };
      },
    })({
      location: { lat: LAUNCH_MARKET.lat, lng: LAUNCH_MARKET.lng },
      messages: [{ role: 'user', content: prompt }],
    });
    assert.deepEqual(queries.sort(), ['bar', 'restaurant']);
    assert.equal(response.proposedPlan?.needs.join(','), 'dining,nightlife');
    assert.equal(response.status, 'ready');
  });
});

describe('bytt-si suggestions: the model picks, the server writes the words', () => {
  it('uses a scripted model when it calls a skill and returns allowed ids', async () => {
    const llm = new FakeProvider({
      chat: (_request, step) => step === 0
        ? { toolCalls: [{ name: 'prime_path', arguments: {} }] }
        : { content: 'done' },
      structured: { suggestion_picks: [{ picks: [
        { id: 'coffee_nearby', planId: null },
        { id: 'plan_the_night', planId: null },
        { id: 'events_nearby', planId: null },
      ] }] },
    });
    const out = await new SuggestionEngine({ llm, ports: ports() }).suggest({ ...base, now: FRIDAY_7_PM });
    assert.equal(out.source, 'si');
    assert.deepEqual(out.suggestions.map((suggestion) => suggestion.id), ['plan_the_night', 'coffee_nearby', 'events_nearby']);
    assert.equal(llm.calls.some((call) => call.kind === 'chat' && call.request.tools?.some((tool) => tool.name === 'prime_path')), true);
    assert.match(String(llm.calls.find((call) => call.kind === 'chat') && (llm.calls[0] as { request: { messages: Array<{ content: string }> } }).request.messages[0].content), /Prime Path/);
  });

  it('drops a share id the guest does not have, and falls back when the model is down or unscripted', async () => {
    const llm = new FakeProvider({
      chat: () => ({ content: 'done' }),
      structured: { suggestion_picks: [{ picks: [
        { id: 'share_plan', planId: 'missing' },
        { id: 'plan_a_show', planId: null },
        { id: 'drinks_nearby', planId: null },
      ] }] },
    });
    const out = await new SuggestionEngine({ llm, ports: ports() }).suggest(base);
    assert.equal(out.source, 'si');
    assert.ok(out.suggestions.some((suggestion) => suggestion.id === 'plan_the_night'));
    assert.ok(out.suggestions.every((suggestion) => suggestion.id !== 'share_plan' && suggestion.id !== 'plan_a_show'));

    const down = await new SuggestionEngine({ llm: new FakeProvider({ down: true }), ports: ports() }).suggest(base);
    assert.equal(down.source, 'curated');
    assert.equal(down.suggestions[0].id, 'plan_the_night');
    const empty = await new SuggestionEngine({ llm: new FakeProvider({ chat: () => ({ content: 'done' }) }), ports: ports() }).suggest(base);
    assert.equal(empty.source, 'curated');
  });
});
