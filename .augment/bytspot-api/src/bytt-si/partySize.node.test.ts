/**
 * Party size when the guest doesn't state one, and the system prompt's
 * description of the model's job now that Prime Path makes the final pick.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { primePathNeedRanker } from './backend/primePath';
import { SYSTEM_PROMPT } from './prompt/index';
import type { EventRecord } from './ports/types';
import type { Candidate } from './skills/index';
import { conciergeResultSchema, type ProposedPlan } from './types';
import { codes } from './testing/assert';
import { discoverBoth, FRIDAY_MESSAGE, fridayIntent, fridaySelection, NOW, setup } from './testing/helpers';
import { SAMPLE_FRIDAY } from './testing/fakePorts';

const ASSUMED = 'Assumed 2 people. Change the group size to update.';
const ranked = (script: Parameters<typeof setup>[0]) => setup(script, {}, { ranker: primePathNeedRanker });
const ev = (id: string, over: Partial<EventRecord>): EventRecord => ({ id, title: `SAMPLE ${id}`, venueName: 'SAMPLE Hall', placeId: null, address: null, latitude: 33.7840, longitude: -84.3832,
  startsAt: '2026-11-06T21:00:00-05:00', endsAt: '2026-11-06T23:00:00-05:00', priceCents: null, capacity: 30, bookableId: `party:${id}`, capability: 'book', ...over });

describe('bytt-si party size: unknown size is assumed 2 and blocks booking', () => {
  it('no party size -> assumes 2, shows the notice and blocks booking', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent({ partySize: null, budgetPerPersonCents: null })], plan_selection: [fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: 'Friday night dinner and drinks in Midtown', now: NOW }) as ProposedPlan;
    conciergeResultSchema.parse(plan);
    assert.equal(plan.partySize, 2);
    assert.equal(plan.partySizeSource, 'assumed');
    assert.ok(plan.notices.some((n) => n.code === 'assumption' && n.message === ASSUMED));
    assert.equal(plan.status, 'needs_changes');
    assert.deepEqual(plan.actions.book, { available: false, reason: 'party_size_unconfirmed' });
    assert.equal(plan.actions.share.available, true);
  });
  it('a per-person budget is checked against the assumed 2', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent({ partySize: null })], plan_selection: [fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: 'Friday dinner and drinks, $60 each', now: NOW }) as ProposedPlan;
    assert.equal(plan.partySize, 2);
    assert.equal(plan.budgetCents, 12000);
  });
  it('uses the known group count from the people skill (named group) and does not block on size', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent({ partySize: null, budgetPerPersonCents: null })], plan_selection: [fridaySelection()] },
      chat: [{ toolCalls: [...discoverBoth.toolCalls, { name: 'people', arguments: { names: ['Ama', 'Kofi'] } }] }] });
    const plan = await engine.handle({ message: 'Friday dinner and drinks with Ama and Kofi', now: NOW, userId: 'SAMPLE_user_1' }) as ProposedPlan;
    assert.equal(plan.partySize, 3);
    assert.equal(plan.partySizeSource, 'group');
    assert.ok(!plan.notices.some((n) => n.message === ASSUMED));
    assert.notEqual(plan.actions.book.reason, 'party_size_unconfirmed');
  });
  it('drops a party with 1 open spot when the size is assumed 2', async () => {
    const { engine, ports } = ranked({ structured: { intent: [fridayIntent({ intent: 'a party', needs: ['event'], partySize: null, budgetPerPersonCents: null })], plan_selection: [{ title: 'Party', pitch: '', items: [{ candidateId: 'event:one', startsAt: null, durationMins: null }] }] },
      chat: [{ toolCalls: [{ name: 'discovery', arguments: { needKind: 'event', query: 'party' } }] }] });
    ports.events.search = async () => ({ source: 'ok', events: [ev('one', { capacity: 1 }), ev('roomy', { latitude: 33.7900 })] });
    const plan = await engine.handle({ message: 'a party Friday', now: NOW }) as ProposedPlan;
    const item = plan.items.find((i) => i.needKind === 'event')!;
    assert.equal(item.candidateId, 'event:roomy');
    assert.match(item.primePath!.reason!, /^★ Prime Path — fits 2/);
    assert.ok(!item.primePath!.alternates.some((a) => a.candidateId === 'event:one'));
    assert.ok(codes(plan.notices).includes('prime_path'));
  });
  it('an explicit size still works and does not block booking', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.equal(plan.partySize, 4);
    assert.equal(plan.partySizeSource, 'stated');
    assert.equal(plan.status, 'proposed');
    assert.equal(plan.actions.book.available, true);
    assert.ok(!plan.notices.some((n) => n.message === ASSUMED));
  });
  it('the unranked (model) path assumes 2 the same way', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent({ partySize: null, budgetPerPersonCents: null })], plan_selection: [fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: 'Friday night dinner and drinks', now: NOW }) as ProposedPlan;
    assert.equal(plan.partySize, 2);
    assert.deepEqual(plan.actions.book, { available: false, reason: 'party_size_unconfirmed' });
  });
});

describe('bytt-si prime path: goingCount never exceeds partySize', () => {
  it('clamps goingCount to partySize, so a minimum above the party is not viable', () => {
    const c: Candidate = { id: 'event:pair', kind: 'event', needKind: 'event', name: 'SAMPLE pair', placeId: null, address: null, latitude: 33.78, longitude: -84.38,
      distanceMeters: 100, rating: null, isOpen: null, priceCents: null, priceBasis: null, startsAt: '2026-11-06T22:00:00-05:00', endsAt: null,
      durationMins: null, capacity: 10, minParty: 2, bookableId: 'party:pair', capability: 'book', crowd: null };
    const r = primePathNeedRanker.rank({ need: 'event', options: [{ candidate: c, bytspot: [], deeplinks: [], travelMinutes: 5 }], partySize: 1, goingCount: 3, window: SAMPLE_FRIDAY });
    assert.equal(r.primeId, null);
    assert.deepEqual(r.dropped, [{ id: 'event:pair', why: 'min_party' }]);
  });
});

describe('bytt-si system prompt: needs in, Prime Path picks', () => {
  it('tells the model to turn the request into needs and that Prime Path makes the final pick; its stops are suggestions from skill results', () => {
    assert.match(SYSTEM_PROMPT, /Prime Path/);
    assert.match(SYSTEM_PROMPT, /final pick/);
    assert.match(SYSTEM_PROMPT, /suggestion/i);
    assert.match(SYSTEM_PROMPT, /needs/);
    for (const word of ['what', 'when', 'how many', 'budget', 'preferences']) assert.ok(SYSTEM_PROMPT.includes(word), word);
    assert.match(SYSTEM_PROMPT, /skill results/);
  });
  it('the in-code prompt is still exactly system.md', () => {
    assert.equal(SYSTEM_PROMPT, readFileSync(join(__dirname, 'prompt', 'system.md'), 'utf8').trim());
  });
});
