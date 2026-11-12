import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config';
import { FakeProvider } from '../bytt-si/llm/fake';
import { SuggestionEngine } from '../bytt-si/suggestions/engine';
import type { SuggestionPorts } from '../bytt-si/suggestions/types';
import { db } from '../lib/db';
import { appRouter } from './router';
import { resetLocalRateLimitForTests } from './trpc';
import type { Context } from './context';
import { conciergeSuggestionsOutput, createConciergeSuggestionsRouter } from './conciergeSuggestionsRouter';

(db.user as { findUnique: unknown }).findUnique = async () => ({ emailVerifiedAt: new Date(), aiConsentAt: new Date() });

const original = {
  conciergeDiscoveryEnabled: config.conciergeDiscoveryEnabled,
  conciergePlanEnabled: config.conciergePlanEnabled,
  conciergeAudience: config.conciergeAudience,
  conciergePilotUserIds: config.conciergePilotUserIds,
  openaiApiKey: config.openaiApiKey,
};
test.afterEach(() => { Object.assign(config, original); resetLocalRateLimitForTests(); });

const member: Context = { user: { userId: 'suggest-user', email: 'member@example.test' }, clientRateLimitKey: 'suggest-test' };
const ports: SuggestionPorts = {
  upcomingPlans: async () => [],
  recentNeeds: async () => [],
  typical: async () => ({ level: 2, label: 'Active' }),
  primePath: async () => ({ status: 'unavailable', confirmableNeeds: [] }),
};

test('concierge.suggestions is an authenticated query beside discover and plan', async () => {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  assert.equal(procedures['concierge.suggestions']._def.type, 'query');
  assert.equal(procedures['concierge.discover']._def.type, 'mutation');
  assert.equal(procedures['concierge.plan']._def.type, 'mutation');
  await assert.rejects(
    () => appRouter.createCaller({ user: null, clientRateLimitKey: 'suggest-anon' }).concierge.suggestions({}),
    { code: 'UNAUTHORIZED' },
  );
});

test('the discovery flag and pilot list gate suggestions, and a closed gate does not build a list', async () => {
  let built = 0;
  const router = createConciergeSuggestionsRouter({
    suggest: async () => { built += 1; throw new Error('should not run'); },
  });
  Object.assign(config, { conciergeDiscoveryEnabled: false, conciergeAudience: 'everyone' });
  const off = await router.createCaller(member).suggestions({});
  assert.equal(off.status, 'unavailable');
  assert.deepEqual(off.suggestions, []);
  assert.match(off.reply ?? '', /not enabled/);
  assert.equal(built, 0);

  Object.assign(config, { conciergeDiscoveryEnabled: true, conciergeAudience: 'pilot', conciergePilotUserIds: '' });
  const outsider = await router.createCaller(member).suggestions({});
  assert.equal(outsider.status, 'unavailable');
  assert.equal(built, 0);
});

test('with the gate open, a missing model still returns a curated Plan prompt', async () => {
  Object.assign(config, { conciergeDiscoveryEnabled: true, conciergeAudience: 'everyone', openaiApiKey: '' });
  const router = createConciergeSuggestionsRouter({
    now: () => new Date('2026-11-14T00:00:00.000Z'),
    suggest: (ctx, input, now) => new SuggestionEngine({ llm: null, ports }).suggest({
      now: now.toISOString(), userId: ctx.user?.userId ?? 'suggest-user',
      latitude: input.location?.lat ?? null, longitude: input.location?.lng ?? null,
      planRouteEnabled: false,
    }),
  });
  const out = await router.createCaller(member).suggestions({});
  conciergeSuggestionsOutput.parse(out);
  assert.equal(out.status, 'ok');
  if (out.status !== 'ok') return;
  assert.equal(out.source, 'curated');
  assert.equal(out.area.basis, 'launch_market');
  assert.ok(out.suggestions.some((suggestion) => suggestion.startsPlan && suggestion.prompt === 'Plan dinner and drinks tonight'));
  assert.ok(out.suggestions.every((suggestion) => suggestion.primePath.note === null));
});

test('a scripted model is the source, and the prompt is what Discover turns into a Plan', async () => {
  Object.assign(config, { conciergeDiscoveryEnabled: true, conciergeAudience: 'pilot', conciergePilotUserIds: member.user!.userId });
  const router = createConciergeSuggestionsRouter({
    now: () => new Date('2026-11-13T13:00:00.000Z'),
    suggest: (ctx, input, now) => new SuggestionEngine({
      llm: new FakeProvider({
        chat: () => ({ content: 'done' }),
        structured: { suggestion_picks: [{ picks: [
          { id: 'plan_the_night', planId: null },
          { id: 'coffee_nearby', planId: null },
          { id: 'lunch_nearby', planId: null },
        ] }] },
      }),
      ports,
    }).suggest({
      now: now.toISOString(), userId: ctx.user?.userId ?? 'suggest-user',
      latitude: input.location?.lat ?? null, longitude: input.location?.lng ?? null, planRouteEnabled: true,
    }),
  });
  const out = await router.createCaller(member).suggestions({ location: { lat: 33.781, lng: -84.3833 } });
  assert.equal(out.status, 'ok');
  if (out.status !== 'ok') return;
  assert.equal(out.source, 'si');
  assert.equal(out.area.label, 'Midtown');
  assert.equal(out.suggestions[1].prompt, 'Coffee nearby');
  await assert.rejects(() => router.createCaller(member).suggestions({ location: { lat: 33.781, lng: -84.3833 }, venues: [] } as never), { code: 'BAD_REQUEST' });
});
