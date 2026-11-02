import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conciergeResultSchema, type ProposedPlan, type QuickAnswer } from './types';
import { assertPartial, codes } from './testing/assert';
import { discoverBoth, FRIDAY_MESSAGE, fridayIntent, fridaySelection, NOW, setup } from './testing/helpers';

const window = (plan: ProposedPlan, check: string) => plan.feasibility.checks.find((c) => c.check === check)!.verdict;

describe('bytt-si engine: Friday Midtown dinner and drinks for 4 under $60 each', () => {
  it('returns a bookable, shareable ProposedPlan within budget that matches the wire schema', async () => {
    const { engine, llm } = setup({
      structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] },
      chat: [discoverBoth, { toolCalls: [{ name: 'bookables', arguments: { placeId: 'SAMPLE_dinner_southern' } }] }, { content: 'ready' }],
    });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW, userId: 'SAMPLE_user_1' }) as ProposedPlan;
    conciergeResultSchema.parse(plan);
    assert.equal(plan.kind, 'plan');
    assert.equal(plan.status, 'proposed');
    assertPartial(plan, { intent: 'dinner and drinks', partySize: 4, budgetCents: 24000, areaLabel: 'Midtown, Atlanta', needs: ['dining', 'drinks'], lifecycle: 'proposed' });
    assert.deepEqual(plan.items.map((i) => i.title), ['SAMPLE Southern Kitchen', 'SAMPLE Rooftop Lounge']);
    assert.deepEqual(plan.items.map((i) => i.startsAt), ['2026-11-06T19:00:00-05:00', '2026-11-06T20:45:00-05:00']);
    assertPartial(plan.budget, { verdict: 'fits', perPersonCents: 5400, totalCents: 21600, basis: 'estimate' });
    assert.equal(window(plan, 'window'), 'fits');
    assert.equal(window(plan, 'travel'), 'fits');
    assert.notEqual(plan.feasibility.verdict, 'breaks');
    assert.deepEqual(plan.items[0].booking, [{ kind: 'deeplink', provider: 'opentable', label: 'OpenTable', url: 'https://www.opentable.com/r/sample-southern-kitchen', availabilityChecked: false }]);
    assert.ok(plan.items.every((i) => i.rides.length === 2 && i.rides.every((r) => r.fareChecked === false)));
    assertPartial(plan.actions, { edit: { available: true }, share: { available: true }, book: { available: true } });
    assert.equal(plan.summary, 'Southern dinner, then rooftop drinks a short walk away. About $54 each.');
    assert.deepEqual(plan.meta.toolCalls, ['discovery', 'discovery', 'bookables']);
    const firstChat = llm.calls.find((c) => c.kind === 'chat')!;
    assert.deepEqual(firstChat.kind === 'chat' && firstChat.request.tools!.map((t) => t.name), ['discovery', 'budget', 'people', 'scheduling', 'routing', 'bookables']);
  });

  it('reschedules model times that ignore travel or the window', async () => {
    const { engine } = setup({
      structured: { intent: [fridayIntent()], plan_selection: [fridaySelection({ items: [
        { candidateId: 'place:SAMPLE_dinner_southern', startsAt: '2026-11-06T19:00:00-05:00', durationMins: 90 },
        { candidateId: 'place:SAMPLE_bar_rooftop', startsAt: '2026-11-06T19:30:00-05:00', durationMins: 75 },
      ] })] },
      chat: [discoverBoth],
    });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.ok(new Date(plan.items[1].startsAt!).getTime() >= new Date('2026-11-06T20:30:00-05:00').getTime());
    assert.ok(codes(plan.notices).includes('schedule_adjusted'));
    assert.equal(window(plan, 'overlap'), 'fits');
  });
});

describe('bytt-si engine: over-budget rejection', () => {
  const pricey = fridaySelection({ pitch: '', items: [
    { candidateId: 'place:SAMPLE_dinner_steak', startsAt: null, durationMins: null },
    { candidateId: 'place:SAMPLE_bar_champagne', startsAt: null, durationMins: null },
  ] });

  it('never returns the over-budget pick; uses the model re-pick when it fits', async () => {
    const { engine, llm } = setup({ structured: { intent: [fridayIntent()], plan_selection: [pricey, fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.deepEqual(plan.items.map((i) => i.candidateId), ['place:SAMPLE_dinner_southern', 'place:SAMPLE_bar_rooftop']);
    assert.equal(plan.budget.verdict, 'fits');
    assert.ok(codes(plan.notices).includes('budget_repaired'));
    assert.equal(llm.calls.filter((c) => c.kind === 'structured' && c.name === 'plan_selection').length, 2);
  });
  it('swaps in cheaper verified candidates in code when the model insists', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [pricey, pricey] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.ok(!plan.items.some((i) => i.title === 'SAMPLE Prime Steakhouse'));
    assert.equal(plan.budget.verdict, 'fits');
    assert.ok(plan.budget.totalCents! <= 24000);
    assert.equal(plan.status, 'proposed');
  });
  it('flags the plan and blocks booking when nothing fits the budget', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent({ budgetPerPersonCents: 1000 })], plan_selection: [fridaySelection(), fridaySelection()] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: 'Friday dinner and drinks for 4, $10 each', now: NOW }) as ProposedPlan;
    assertPartial(plan, { kind: 'plan', budgetCents: 4000, status: 'needs_changes', budget: { verdict: 'breaks' }, actions: { book: { available: false }, edit: { available: true } } });
    assert.ok(codes(plan.notices).includes('over_budget'));
  });
});

describe('bytt-si engine: provider-down honesty', () => {
  it('says places are unavailable and drops venues no provider returned', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection({ pitch: 'Dinner at SAMPLE Southern Kitchen, $34 each.' })] }, chat: [discoverBoth] }, { placesDown: true });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assertPartial(plan, { kind: 'plan', items: [], status: 'needs_changes' });
    for (const code of ['provider_unavailable', 'dropped_unverified_item', 'no_options']) assert.ok(codes(plan.notices).includes(code), code);
    assert.match(plan.notices.find((n) => n.code === 'provider_unavailable')!.message, /unavailable right now/);
    assert.doesNotMatch(plan.summary, /Southern Kitchen/);
  });
  it('keeps the plan but says booking info is unavailable', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] }, { bookablesDown: true });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.equal(plan.items.length, 2);
    assert.ok(plan.items.every((i) => i.booking.length === 0));
    assert.ok(plan.notices.some((n) => n.code === 'provider_unavailable' && /Booking info is unavailable/.test(n.message)));
    assert.equal(plan.actions.book.available, false);
  });
  it('still returns a ProposedPlan (no invented options) when the LLM is down', async () => {
    const { engine } = setup({ down: true });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assertPartial(plan, { kind: 'plan', status: 'needs_changes', items: [], partySize: 4, budgetCents: 24000 });
    assert.ok(codes(plan.notices).includes('assistant_unavailable'));
  });
});

describe('bytt-si engine: quick-question path', () => {
  it('gives a short answer plus a "make it a plan" suggestion', async () => {
    const { engine } = setup({
      structured: { intent: [fridayIntent({ mode: 'quick', intent: 'cocktail bar nearby', needs: ['drinks'], partySize: null, budgetPerPersonCents: null })],
        quick_answer: [{ answer: 'SAMPLE Speakeasy 10th is the closest cocktail bar, a few minutes walk from you.' }] },
      chat: [{ toolCalls: [{ name: 'discovery', arguments: { needKind: 'drinks', query: 'cocktail bar' } }] }, { content: 'ok' }],
    });
    const out = await engine.handle({ message: "What's a good cocktail bar near me?", now: NOW }) as QuickAnswer;
    conciergeResultSchema.parse(out);
    assert.equal(out.kind, 'quick_answer');
    assert.match(out.answer, /Speakeasy/);
    assert.equal(out.makePlanSuggestion.label, 'Make it a plan');
    assertPartial(out.makePlanSuggestion.prefill, { needs: ['drinks'], areaLabel: 'Midtown, Atlanta' });
  });
  it('caps quick questions at a few steps', async () => {
    const { engine } = setup({
      structured: { intent: [fridayIntent({ mode: 'quick', needs: ['drinks'] })], quick_answer: [{ answer: 'Try SAMPLE Speakeasy 10th.' }] },
      chat: () => ({ toolCalls: [{ name: 'discovery', arguments: { needKind: 'drinks', query: 'bar' } }] }),
    });
    const out = await engine.handle({ message: 'any bars?', now: NOW });
    assert.equal(out.meta.steps, 3);
    assert.ok(codes(out.notices).includes('step_cap'));
  });
});

describe('bytt-si engine: no-live-label rule', () => {
  it('labels typical crowd as typical and replaces a "packed right now" pitch', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection({ pitch: 'The rooftop is packed right now — live crowd says go early!' })] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assertPartial(plan.items.find((i) => i.title === 'SAMPLE Rooftop Lounge')!.crowd, { source: 'typical', label: 'Usually packed around this time (typical, not live)' });
    assert.doesNotMatch(plan.summary, /live|right now/i);
    assert.ok(codes(plan.notices).includes('text_replaced'));
    assert.ok(codes(plan.notices).includes('typical_not_live'));
  });
  it('replaces a quick answer that calls typical data live', async () => {
    const { engine } = setup({
      structured: { intent: [fridayIntent({ mode: 'quick', needs: ['drinks'] })], quick_answer: [{ answer: 'SAMPLE Rooftop Lounge is packed right now.' }] },
      chat: [{ toolCalls: [{ name: 'discovery', arguments: { needKind: 'drinks', query: 'rooftop' } }] }],
    });
    const out = await engine.handle({ message: 'Is the rooftop busy right now?', now: NOW }) as QuickAnswer;
    assert.doesNotMatch(out.answer, /packed right now/);
    assert.match(out.answer, /typical, not live/);
    assert.ok(codes(out.notices).includes('text_replaced'));
  });
  it('replaces a pitch that invents a price', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection({ pitch: 'Only $15 each all night!' })] }, chat: [discoverBoth] });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.doesNotMatch(plan.summary, /\$15/);
    assert.match(plan.summary, /\$54 each/);
  });
});

describe('bytt-si engine: tool loop safety', () => {
  it('stops at the step cap and still returns a plan', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: () => ({ toolCalls: [{ name: 'budget', arguments: { stops: [] } }] }) }, {}, { maxSteps: 4 });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.equal(plan.meta.steps, 4);
    assert.ok(codes(plan.notices).includes('step_cap'));
    assert.equal(plan.items.length, 2);
  });
  it('returns errors to the model for unknown skills and bad arguments', async () => {
    const { engine, llm } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] },
      chat: [{ toolCalls: [{ name: 'book_uber', arguments: {} }, { name: 'discovery', arguments: { needKind: 'spa' } }] }, discoverBoth] });
    await engine.handle({ message: FRIDAY_MESSAGE, now: NOW });
    const second = llm.calls.filter((c) => c.kind === 'chat')[1];
    const tools = second.kind === 'chat' ? second.request.messages.filter((m) => m.role === 'tool') : [];
    assert.match(tools[0].content as string, /Unknown skill/);
    assert.match(tools[1].content as string, /Invalid arguments/);
  });
});

describe('bytt-si engine: Bytspot events and the final check', () => {
  it('turns a bookable Bytspot party into a Bytspot booking option (no invented price)', async () => {
    const { engine } = setup({
      structured: { intent: [fridayIntent({ needs: ['dining', 'event'] })], plan_selection: [{ title: 'Dinner and jazz', pitch: '', items: [
        { candidateId: 'place:SAMPLE_dinner_taqueria', startsAt: null, durationMins: null },
        { candidateId: 'event:SAMPLE_event_jazz', startsAt: null, durationMins: null },
      ] }] },
      chat: [{ toolCalls: [{ name: 'discovery', arguments: { needKind: 'dining', query: 'tacos' } }, { name: 'discovery', arguments: { needKind: 'event', query: 'jazz' } }] }],
    });
    const plan = await engine.handle({ message: 'Friday dinner then jazz for 4, $60 each', now: NOW }) as ProposedPlan;
    const jazz = plan.items.find((i) => i.candidateId === 'event:SAMPLE_event_jazz')!;
    assertPartial(jazz, { startsAt: '2026-11-06T22:00:00-05:00', timeSource: 'fixed', capability: 'book', priceCents: null });
    assert.deepEqual(jazz.booking, [{ kind: 'bytspot', bookableId: 'party:SAMPLE_event_jazz', capability: 'book', tierName: 'Party entry', priceCents: null, capacity: 40 }]);
    assert.equal(plan.budget.verdict, 'unknown', 'an unpriced stop keeps the budget unknown, never fits');
  });

  it('lets the backend final check (planFeasibility) overrule the engine', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] }, {}, {
      finalCheck: async () => ({ verdict: 'breaks', checks: [{ check: 'capacity', verdict: 'breaks', detail: 'SAMPLE Rooftop Lounge can\'t seat 4.' }] }),
    });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assertPartial(plan, { status: 'needs_changes', feasibility: { verdict: 'breaks' }, actions: { book: { available: false } } });
    assert.ok(plan.notices.some((n) => n.code === 'final_check' && /can't seat 4/.test(n.message)));
  });

  it('says so when the final check cannot run, and blocks booking', async () => {
    const { engine } = setup({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] }, {}, {
      finalCheck: async () => { throw new Error('db down'); },
    });
    const plan = await engine.handle({ message: FRIDAY_MESSAGE, now: NOW }) as ProposedPlan;
    assert.equal(plan.actions.book.available, false);
    assert.ok(plan.notices.some((n) => n.code === 'final_check' && /couldn't run/.test(n.message)));
  });
});
