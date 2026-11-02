/** Test helpers for BYTT-SI. Never imported by runtime code. */
import { createEngine, type EngineOptions } from '../engine';
import { FakeProvider, type FakeScript } from '../llm/fake';
import type { SkillContext } from '../skills/types';
import { MIDTOWN } from '../types';
import { createFakePorts, SAMPLE_FRIDAY, type FakePortOptions } from './fakePorts';

export const NOW = '2026-11-02T10:00:00-05:00';
export const FRIDAY_MESSAGE = 'Friday night dinner and drinks in Midtown for 4, under $60 each';

export const fridayIntent = (overrides: Record<string, unknown> = {}) => ({
  mode: 'plan', intent: 'dinner and drinks', needs: ['dining', 'drinks'],
  startsAt: SAMPLE_FRIDAY.startsAt, endsAt: SAMPLE_FRIDAY.endsAt, areaLabel: 'Midtown',
  partySize: 4, budgetPerPersonCents: 6000, budgetTotalCents: null, radiusMiles: null, preferences: [],
  ...overrides,
});

export const fridaySelection = (overrides: Record<string, unknown> = {}) => ({
  title: 'Friday in Midtown',
  pitch: 'Southern dinner, then rooftop drinks a short walk away. About $54 each.',
  items: [
    { candidateId: 'place:SAMPLE_dinner_southern', startsAt: '2026-11-06T19:00:00-05:00', durationMins: 90 },
    { candidateId: 'place:SAMPLE_bar_rooftop', startsAt: '2026-11-06T20:45:00-05:00', durationMins: 75 },
  ],
  ...overrides,
});

export const discoverBoth = { toolCalls: [
  { name: 'discovery', arguments: { needKind: 'dining', query: 'dinner' } },
  { name: 'discovery', arguments: { needKind: 'drinks', query: 'cocktail bar' } },
] };

export function setup(script: FakeScript, portOptions: FakePortOptions = {}, engineOptions: Partial<EngineOptions> = {}) {
  const llm = new FakeProvider(script);
  const ports = createFakePorts(portOptions);
  const engine = createEngine({ llm, ports, ...engineOptions });
  return { llm, ports, engine };
}

export function skillContext(portOptions: FakePortOptions = {}, overrides: Partial<SkillContext['defaults']> = {}, now = '2026-11-06T21:10:00-05:00'): SkillContext & { ports: ReturnType<typeof createFakePorts> } {
  return {
    ports: createFakePorts(portOptions), userId: 'SAMPLE_user_1', now,
    defaults: { latitude: MIDTOWN.latitude, longitude: MIDTOWN.longitude, radiusMiles: 1.5, startsAt: SAMPLE_FRIDAY.startsAt, endsAt: SAMPLE_FRIDAY.endsAt, partySize: 4, budgetCents: 24000, ...overrides },
  };
}
