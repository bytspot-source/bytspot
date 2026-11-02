/**
 * Prime Path inside BYTT-SI. The model understands the request and names the
 * needs; the existing Prime Path ranker (services/primePath.ts, unchanged)
 * makes the final pick per need. These tests pin the honest candidate mapping
 * (backend/primePath.ts) and how the engine uses the ranking.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { primePathReason, rankPrimePath } from '../services/primePath';
import { primePathCandidateFor, primePathNeedRanker, type RankableOption } from './backend/primePath';
import type { Candidate } from './skills/index';
import { conciergeResultSchema, type ProposedPlan } from './types';
import type { EventRecord } from './ports/types';
import { codes } from './testing/assert';
import { discoverBoth, FRIDAY_MESSAGE, fridayIntent, fridaySelection, NOW, setup } from './testing/helpers';
import { SAMPLE_FRIDAY } from './testing/fakePorts';

const WINDOW = { startsAt: SAMPLE_FRIDAY.startsAt, endsAt: SAMPLE_FRIDAY.endsAt };

const base: Candidate = {
  id: 'x', kind: 'place', needKind: 'nightlife', name: 'x', placeId: null, address: null, latitude: 33.78, longitude: -84.38,
  distanceMeters: 100, rating: null, isOpen: null, priceCents: null, priceBasis: null, startsAt: null, endsAt: null,
  durationMins: null, capacity: null, minParty: null, bookableId: null, capability: 'details', crowd: null,
};
const party = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  ...base, id: `event:${id}`, kind: 'event', needKind: 'event', name: `SAMPLE ${id}`, bookableId: `party:${id}`, capability: 'book',
  capacity: 20, startsAt: '2026-11-06T22:00:00-05:00', endsAt: '2026-11-06T23:30:00-05:00', ...over,
});
const openTablePlace = (id: string): Candidate => ({ ...base, id: `place:${id}`, placeId: id, name: `SAMPLE ${id}` });
const option = (candidate: Candidate, over: Partial<RankableOption> = {}): RankableOption => ({ candidate, bytspot: [], deeplinks: [], travelMinutes: null, ...over });
const OT_LINK = { kind: 'deeplink' as const, provider: 'opentable' as const, label: 'OpenTable', url: 'https://www.opentable.com/r/sample', availabilityChecked: false as const };
const rank = (options: RankableOption[], partySize = 4, goingCount = 1) =>
  primePathNeedRanker.rank({ need: 'nightlife', options, partySize, goingCount, window: WINDOW });

describe('bytt-si prime path: honest candidate mapping', () => {
  it('maps a Bytspot party as own inventory with live seats, capability from the projection, neutral reliability/continuation and no commercial input', () => {
    const c = primePathCandidateFor(option(party('p1', { capacity: 7, capability: 'request', priceCents: 5000 }), { travelMinutes: 12 }), WINDOW);
    assert.ok(c);
    assert.equal(c.ownInventory, true);
    assert.equal(c.capability, 'request');
    assert.equal(c.seats, 7);
    assert.equal(c.minParty, 1);
    assert.equal(c.confirmableNow, true);
    assert.equal(c.travelMinutes, 12);
    assert.equal(c.reliability, 0);
    assert.equal(c.continuationValue, 0);
    assert.equal(c.startLabel, '10:00 PM');
    for (const key of Object.keys(c)) assert.ok(!/price|cents|fee|commission|sponsor|paid/i.test(key), `commercial key ${key}`);
  });
  it('maps a place with a Bytspot bookable as own inventory; an OpenTable/Resy/Google place is never a Prime Path candidate', () => {
    const own = primePathCandidateFor(option(openTablePlace('booth'), { bytspot: [{ kind: 'bytspot', bookableId: 'BYT-1', capability: 'book', tierName: 'Booth', priceCents: 2400, capacity: 6 }] }), WINDOW);
    assert.ok(own);
    assert.equal(own.ownInventory, true);
    assert.equal(own.seats, 6);
    assert.equal(primePathCandidateFor(option(openTablePlace('ot'), { deeplinks: [OT_LINK] }), WINDOW), null);
    assert.equal(primePathCandidateFor(option(openTablePlace('google')), WINDOW), null);
    assert.equal(primePathCandidateFor(option(party('tm', { bookableId: null, capability: 'details' })), WINDOW), null);
  });
  it('a party with unknown seats or outside the plan window is not confirmable (never Typical, never assumed)', () => {
    assert.equal(primePathCandidateFor(option(party('nocap', { capacity: null })), WINDOW)!.confirmableNow, false);
    assert.equal(primePathCandidateFor(option(party('late', { startsAt: '2026-11-07T02:00:00-05:00', endsAt: null })), WINDOW)!.confirmableNow, false);
  });
});

describe('bytt-si prime path: ranking per need', () => {
  it('prime from an own party beats an OpenTable link', () => {
    const r = rank([option(openTablePlace('ot'), { deeplinks: [OT_LINK], travelMinutes: 2 }), option(party('p1'), { travelMinutes: 20 })]);
    assert.equal(r.primeId, 'event:p1');
    assert.match(r.reason!, /^★ Prime Path — fits 4 at 10:00 PM, 20 min away, confirmable now$/);
    assert.deepEqual(r.rankedAlternateIds, []);
    assert.deepEqual(r.unrankedIds, ['place:ot']);
  });
  it('the reason line is the one primePathReason writes (not re-implemented)', () => {
    const opts = [option(party('p1'), { travelMinutes: 5 })];
    const r = rank(opts);
    const ranked = rankPrimePath([primePathCandidateFor(opts[0], WINDOW)!], { partySize: 4, goingCount: 1 });
    assert.equal(r.reason, ranked.reason);
    assert.equal(r.reason, primePathReason(ranked.prime!, { partySize: 4, goingCount: 1 }));
  });
  it('deep-link-only need gives no prime and lists the links as alternates only', () => {
    const r = rank([option(openTablePlace('a'), { deeplinks: [OT_LINK], travelMinutes: 9 }), option(openTablePlace('b'), { travelMinutes: 3 })]);
    assert.equal(r.primeId, null);
    assert.equal(r.reason, null);
    assert.deepEqual(r.rankedAlternateIds, []);
    assert.deepEqual(r.unrankedIds, ['place:b', 'place:a']);
  });
  it('drops a party with fewer seats than the party size (not even an alternate)', () => {
    const r = rank([option(party('small', { capacity: 3 }), { travelMinutes: 1 }), option(party('big'), { travelMinutes: 30 })], 4);
    assert.equal(r.primeId, 'event:big');
    assert.ok(![...r.rankedAlternateIds, ...r.unrankedIds].includes('event:small'));
    assert.deepEqual(r.dropped, [{ id: 'event:small', why: 'seats' }]);
  });
  it('drops a path whose minimum party is more than have committed', () => {
    const r = rank([option(party('quorum', { minParty: 6 }), { travelMinutes: 1 }), option(party('ok'), { travelMinutes: 30 })], 4, 1);
    assert.equal(r.primeId, 'event:ok');
    assert.ok(![...r.rankedAlternateIds, ...r.unrankedIds].includes('event:quorum'));
    assert.deepEqual(r.dropped, [{ id: 'event:quorum', why: 'min_party' }]);
  });
  it('unknown travel sorts after known travel', () => {
    const r = rank([option(party('unknown'), { travelMinutes: null }), option(party('known'), { travelMinutes: 25 })]);
    assert.equal(r.primeId, 'event:known');
    assert.deepEqual(r.rankedAlternateIds, ['event:unknown']);
    assert.doesNotMatch(r.reason!, /null|NaN/);
  });
});

// ─── Engine with the Prime Path ranker ───────────────────────────────────────
const ranked = (script: Parameters<typeof setup>[0], ports: Parameters<typeof setup>[1] = {}) => setup(script, ports, { ranker: primePathNeedRanker });
const item = (plan: ProposedPlan, need: string) => plan.items.find((i) => i.needKind === need)!;

describe('bytt-si engine + Prime Path', () => {
  it('features the Prime Path pick with its reason line; the deep-link-only need shows a labeled suggestion, no badge', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW, userId: 'SAMPLE_user_1' }) as ProposedPlan;
    conciergeResultSchema.parse(plan);
    assert.equal(plan.ranking, 'prime_path');
    const drinks = item(plan, 'drinks');
    assert.equal(drinks.candidateId, 'place:SAMPLE_bar_speakeasy');
    assert.equal(drinks.primePath!.status, 'prime');
    assert.match(drinks.primePath!.reason!, /^★ Prime Path — fits 4, \d+ min away, confirmable now$/);
    assert.deepEqual(drinks.primePath!.alternates.map((a) => [a.candidateId, a.ranked]), [['place:SAMPLE_bar_rooftop', false], ['place:SAMPLE_bar_champagne', false]]);
    const dining = item(plan, 'dining');
    assert.equal(dining.candidateId, 'place:SAMPLE_dinner_southern');
    assert.equal(dining.primePath!.status, 'suggestion');
    assert.equal(dining.primePath!.reason, null);
    assert.match(dining.primePath!.note!, /^Suggestion/);
    assert.ok(!JSON.stringify(dining).includes('★'));
    assert.ok(dining.primePath!.alternates.every((a) => a.ranked === false));
  });
  it('the model cannot override the Prime Path pick', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection({
      pitch: 'Southern dinner, then drinks at SAMPLE Rooftop Lounge.',
      items: [{ candidateId: 'place:SAMPLE_dinner_southern', startsAt: null, durationMins: null }, { candidateId: 'place:SAMPLE_bar_rooftop', startsAt: null, durationMins: null }],
    })] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.equal(item(plan, 'drinks').candidateId, 'place:SAMPLE_bar_speakeasy');
    assert.equal(item(plan, 'drinks').primePath!.status, 'prime');
    assert.ok(!plan.summary.includes('SAMPLE Rooftop Lounge'), 'pitch naming the overridden stop is replaced');
    assert.ok(codes(plan.notices).includes('text_replaced'));
  });
  it('a prime that breaks the budget falls to the next viable alternate and says why', async () => {
    const { engine } = ranked({ structured: { intent: [fridayIntent({ budgetPerPersonCents: 4200 })], plan_selection: [fridaySelection({
      pitch: '', items: [{ candidateId: 'place:SAMPLE_dinner_taqueria', startsAt: null, durationMins: null }],
    })] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: 'Friday dinner and drinks for 4, $42 each', now: NOW }) as ProposedPlan;
    conciergeResultSchema.parse(plan);
    assert.equal(item(plan, 'dining').candidateId, 'place:SAMPLE_dinner_taqueria');
    const drinks = item(plan, 'drinks');
    assert.equal(drinks.candidateId, 'place:SAMPLE_bar_rooftop');
    assert.equal(drinks.primePath!.status, 'fallback');
    assert.equal(drinks.primePath!.reason, null);
    assert.match(drinks.primePath!.note!, /SAMPLE Speakeasy 10th.*over (your )?budget/);
    assert.equal(plan.budget.verdict, 'fits');
    assert.ok(codes(plan.notices).includes('prime_path'));
  });
  it('drops seat-short and quorum-trap parties from the event need', async () => {
    const ev = (id: string, over: Partial<EventRecord>): EventRecord => ({ id, title: `SAMPLE ${id}`, venueName: 'SAMPLE Hall', placeId: null, address: null, latitude: 33.7840, longitude: -84.3832,
      startsAt: '2026-11-06T21:00:00-05:00', endsAt: '2026-11-06T23:00:00-05:00', priceCents: null, capacity: 30, bookableId: `party:${id}`, capability: 'book', ...over });
    const { engine, ports } = ranked({ structured: { intent: [fridayIntent({ intent: 'a party', needs: ['event'], budgetPerPersonCents: null })], plan_selection: [{ title: 'Party', pitch: '', items: [{ candidateId: 'event:tiny', startsAt: null, durationMins: null }] }] },
      chat: [{ toolCalls: [{ name: 'discovery', arguments: { needKind: 'event', query: 'party' } }] }] });
    ports.events.search = async () => ({ source: 'ok', events: [ev('tiny', { capacity: 2 }), ev('quorum', { minParty: 6 }), ev('open', { latitude: 33.7900 })] });
    const plan = await engine.handle({ message: 'a party Friday for 4', now: NOW }) as ProposedPlan;
    const event = item(plan, 'event');
    assert.equal(event.candidateId, 'event:open');
    assert.equal(event.primePath!.status, 'prime');
    assert.ok(!event.primePath!.alternates.some((a) => ['event:tiny', 'event:quorum'].includes(a.candidateId)));
  });
  it('without a ranker the plan says the model picked (v1 behavior unchanged)', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.equal(plan.ranking, 'model');
    assert.ok(plan.items.every((i) => i.primePath === null));
  });
  it('the backend engine is wired to Prime Path', async () => {
    const { BACKEND_RANKER } = await import('./backend/index');
    assert.equal(BACKEND_RANKER, primePathNeedRanker);
    assert.equal(primePathNeedRanker.name, 'prime_path');
  });
});
