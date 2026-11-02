import { z } from 'zod';
import { evaluateBudget } from './core/budget';
import { rideLinks } from './core/deepLinks';
import { honestyViolations } from './core/honesty';
import { intentSchema, normalizeConstraints, type ParsedIntent } from './core/intent';
import { money } from './core/money';
import { capacityCheck, DEFAULT_DURATION_MINS, overallVerdict, scheduleChecks, scheduleStops } from './core/schedule';
import { clockLabel } from './core/time';
import type { ChatMessage, LLMProvider } from './llm/types';
import type { Ports } from './ports/types';
import { loadSystemPrompt } from './prompt/index';
import { estimateTravel } from './core/geo';
import { bookablesSkill, discoverySkill, SKILLS, toToolDefinition, travelBetween, type Candidate, type Skill, type SkillContext } from './skills/index';
import { DISCOVERY_NEEDS } from './skills/discovery';
import type { NeedRanker, NeedRanking, RankableOption } from './ranking';
import type { BookingOption, ConciergeRequest, ConciergeResult, ItemRanking, Notice, PlanConstraints, ProposedPlan, ProposedPlanItem, QuickAnswer } from './types';

export interface EngineOptions {
  llm: LLMProvider;
  ports: Ports;
  /** Cap on LLM tool-loop turns. Default 6. */
  maxSteps?: number;
  /** How many times the model may re-pick after a failed budget check. Default 1. */
  maxRepairs?: number;
  systemPrompt?: string;
  skills?: readonly Skill[];
  /**
   * Authoritative feasibility from the host (bytspot-api wires planFeasibility).
   * Runs last; a `breaks` overrules the engine, and a failure blocks booking.
   */
  finalCheck?: (plan: ProposedPlan) => Promise<{ verdict: 'fits' | 'breaks' | 'unknown'; checks: ProposedPlan['feasibility']['checks'] }>;
  /**
   * Per-need ranker that makes the final pick (bytspot-api wires Prime Path).
   * When set, the model only names the needs and may suggest among
   * alternates where nothing can be featured; it cannot override a prime.
   */
  ranker?: NeedRanker;
}

/** Model's final pick (structured output "plan_selection"). Ids only — facts come from the ledger. */
export const planSelectionSchema = z.object({
  title: z.string().min(1).max(80),
  pitch: z.string().max(600).default(''),
  items: z.array(z.object({
    candidateId: z.string().describe('id of a candidate returned by discovery'),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    durationMins: z.number().int().min(5).max(600).nullable().default(null),
  })).max(8),
});
export type PlanSelection = z.infer<typeof planSelectionSchema>;
export const quickAnswerSchema = z.object({ answer: z.string().min(1).max(600) });

type BookablesOut = Awaited<ReturnType<typeof bookablesSkill.run>>;

/** Everything skills returned this run. The plan may only contain what is in here. */
class Ledger {
  readonly candidates = new Map<string, Candidate>();
  readonly bookables = new Map<string, BookablesOut>();
  readonly discoveredNeeds = new Set<string>();
  /** Head count of a group the guest named (people skill), including the guest. */
  groupSize: number | null = null;
  readonly notices: Notice[] = [];
  record(skill: string, input: unknown, output: unknown) {
    if (skill === 'discovery') {
      const out = output as Awaited<ReturnType<typeof discoverySkill.run>>;
      this.discoveredNeeds.add((input as { needKind: string }).needKind);
      for (const c of out.candidates) this.candidates.set(c.id, c);
      if (out.status === 'unavailable' && out.message) this.notices.push({ code: 'provider_unavailable', message: out.message });
      if (out.status === 'stale' && out.message) this.notices.push({ code: 'provider_stale', message: out.message });
    } else if (skill === 'bookables') {
      const out = output as BookablesOut;
      this.bookables.set((input as { placeId: string }).placeId, out);
      if (out.status === 'unavailable') this.notices.push({ code: 'provider_unavailable', message: out.message });
    } else if (skill === 'people') {
      const out = output as { status: string; message: string | null; partySizeHint: number | null };
      // Only a named group is a participant count; "my usual circle" is not who is coming.
      if ((input as { names?: string[] }).names?.length && out.status !== 'unavailable' && out.partySizeHint) this.groupSize = out.partySizeHint;
      if (out.status === 'unavailable' && out.message) this.notices.push({ code: 'provider_unavailable', message: out.message });
    } else if (skill === 'routing') {
      const out = output as { status: string; message: string | null };
      if (out.status === 'unavailable' && out.message) this.notices.push({ code: 'provider_unavailable', message: out.message });
    }
  }
}

export const ASSUMED_PARTY_SIZE = 2;
export const PARTY_SIZE_UNCONFIRMED = 'party_size_unconfirmed';
export const ASSUMED_PARTY_NOTICE = 'Assumed 2 people. Change the group size to update.';

/** Fill a missing party size in place and say where it came from. */
function resolvePartySize(constraints: PlanConstraints, groupSize: number | null, perPersonCents: number | null, notices: Notice[]): ProposedPlan['partySizeSource'] {
  let source: ProposedPlan['partySizeSource'] = 'stated';
  if (constraints.partySize === null) {
    if (groupSize) { constraints.partySize = Math.min(50, groupSize); source = 'group'; }
    else { constraints.partySize = ASSUMED_PARTY_SIZE; source = 'assumed'; notices.push({ code: 'assumption', message: ASSUMED_PARTY_NOTICE }); }
  }
  if (constraints.budgetCents === null && perPersonCents !== null) constraints.budgetCents = perPersonCents * constraints.partySize;
  return source;
}

const dedupe = (notices: Notice[]) => notices.filter((n, i) => notices.findIndex((m) => m.code === n.code && m.message === n.message) === i);

export class ByttSiEngine {
  private readonly llm: LLMProvider;
  private readonly ports: Ports;
  private readonly maxSteps: number;
  private readonly maxRepairs: number;
  private readonly system: string;
  private readonly skills: readonly Skill[];
  private readonly finalCheck: EngineOptions['finalCheck'];
  readonly ranker: NeedRanker | undefined;

  constructor(options: EngineOptions) {
    this.llm = options.llm;
    this.ports = options.ports;
    this.maxSteps = options.maxSteps ?? 6;
    this.maxRepairs = options.maxRepairs ?? 1;
    this.system = options.systemPrompt ?? loadSystemPrompt();
    this.skills = options.skills ?? SKILLS;
    this.finalCheck = options.finalCheck;
    this.ranker = options.ranker;
  }

  async handle(request: ConciergeRequest): Promise<ConciergeResult> {
    const result = await this.propose(request);
    return result.kind === 'plan' ? this.applyFinalCheck(result) : result;
  }

  private async applyFinalCheck(plan: ProposedPlan): Promise<ProposedPlan> {
    if (!this.finalCheck || !plan.items.length) return plan;
    try {
      const final = await this.finalCheck(plan);
      if (final.verdict !== 'breaks') return plan;
      const broken = final.checks.filter((c) => c.verdict === 'breaks').map((c) => c.detail).join(' ');
      return {
        ...plan, status: 'needs_changes', feasibility: final,
        notices: [...plan.notices, { code: 'final_check', message: `Plan check: ${broken}` }],
        actions: { ...plan.actions, book: { available: false, reason: plan.partySizeSource === 'assumed' ? PARTY_SIZE_UNCONFIRMED : 'Fix the flagged checks first.' } },
      };
    } catch {
      return {
        ...plan,
        notices: [...plan.notices, { code: 'final_check', message: "We couldn't run the final plan check right now, so booking is paused." }],
        actions: { ...plan.actions, book: { available: false, reason: plan.partySizeSource === 'assumed' ? PARTY_SIZE_UNCONFIRMED : 'The final plan check could not run.' } },
      };
    }
  }

  private async propose(request: ConciergeRequest): Promise<ConciergeResult> {
    const notices: Notice[] = [];
    const meta = { provider: this.llm.name, steps: 0, toolCalls: [] as string[] };
    const contextLine = `Now: ${request.now} (America/New_York). Area: ${request.areaLabel ?? 'not given (default Midtown Atlanta)'}.`;

    // 1. Understand: intent, preferences, context, budget.
    let parsed: ParsedIntent | null = null;
    let llmUp = true;
    try {
      parsed = await this.llm.structured({ name: 'intent', schema: intentSchema, messages: [
        { role: 'system', content: this.system },
        { role: 'user', content: `${contextLine}\nExtract the request as JSON (mode, intent, needs, startsAt, endsAt, areaLabel, partySize, budgetPerPersonCents, budgetTotalCents, radiusMiles, preferences).\n\nRequest: ${request.message}` },
      ] });
    } catch {
      llmUp = false;
      notices.push({ code: 'assistant_unavailable', message: "The concierge assistant is unavailable right now, so I couldn't build options. Nothing here was made up." });
    }
    const { constraints, notices: parseNotices, perPersonCents } = normalizeConstraints(parsed, request);
    notices.push(...parseNotices);
    if (!llmUp) {
      const sizeSource = resolvePartySize(constraints, null, perPersonCents, notices);
      return this.finalizePlan(constraints, [], new Ledger(), { title: 'Your plan', pitch: '', items: [] }, notices, meta, 'model', sizeSource);
    }

    const context: SkillContext = {
      ports: this.ports, userId: request.userId ?? null, now: request.now,
      defaults: { latitude: constraints.latitude!, longitude: constraints.longitude!, radiusMiles: constraints.radiusMiles ?? 1.5,
        startsAt: constraints.startsAt, endsAt: constraints.endsAt, partySize: constraints.partySize, budgetCents: constraints.budgetCents },
    };
    const mode = parsed!.mode;

    // 2. Tool loop.
    const ledger = new Ledger();
    const messages: ChatMessage[] = [
      { role: 'system', content: this.system },
      { role: 'user', content: `${contextLine}\nMode: ${mode}. Constraints (budgetCents is the group total): ${JSON.stringify(constraints)}\n\nRequest: ${request.message}` },
    ];
    const tools = this.skills.map(toToolDefinition);
    let capped = false;
    try {
      for (let step = 0; ; step += 1) {
        if (step >= (mode === 'quick' ? Math.min(3, this.maxSteps) : this.maxSteps)) { capped = true; break; }
        const reply = await this.llm.chat({ messages, tools, toolChoice: 'auto' });
        meta.steps += 1;
        if (!reply.toolCalls.length) break;
        messages.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
          meta.toolCalls.push(call.name);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: await this.runSkill(call.name, call.arguments, context, ledger) });
        }
      }
    } catch {
      llmUp = false;
      notices.push({ code: 'assistant_unavailable', message: 'The concierge assistant stopped responding; this plan was finished with fixed rules.' });
    }
    if (capped) notices.push({ code: 'step_cap', message: `Stopped after ${this.maxSteps} assistant steps; planned with what was found.` });

    // Code-side guarantee: every stop kind the guest asked for was actually searched.
    if (mode === 'plan') {
      for (const need of constraints.needs) {
        if ((DISCOVERY_NEEDS as readonly string[]).includes(need) && !ledger.discoveredNeeds.has(need)) {
          await this.runSkill('discovery', { needKind: need, query: need }, context, ledger);
        }
      }
    }
    notices.push(...ledger.notices);

    if (mode === 'quick') return this.quick(request, constraints, ledger, messages, notices, meta, llmUp);

    // Party size: stated, else the named group's count, else assume 2 (booking blocked until confirmed).
    const sizeSource = resolvePartySize(constraints, ledger.groupSize, perPersonCents, notices);
    context.defaults.partySize = constraints.partySize;

    // 3a. With a ranker (Prime Path), the ranker makes the final pick per need.
    if (this.ranker && constraints.needs.some((n) => (DISCOVERY_NEEDS as readonly string[]).includes(n))) {
      const suggestions = llmUp ? await this.select(messages, ledger, constraints, null) : null;
      return this.rankedPlan(this.ranker, request, constraints, ledger, suggestions, notices, meta, context, sizeSource);
    }

    // 3. Compose: the model picks candidate ids; code builds and checks the plan.
    let selection = llmUp ? await this.select(messages, ledger, constraints, null) : null;
    if (!selection) selection = this.fallbackSelection(constraints, ledger);
    let items = await this.buildItems(selection, ledger, constraints, notices, context);
    let budget = evaluateBudget(items, constraints.partySize, constraints.budgetCents);

    // 4. Budget enforced in code: model re-pick, then deterministic swap.
    for (let attempt = 0; budget.verdict === 'breaks' && attempt < this.maxRepairs && llmUp; attempt += 1) {
      const retry = await this.select(messages, ledger, constraints, budget.detail);
      if (!retry) break;
      const retryItems = await this.buildItems(retry, ledger, constraints, [], context);
      const retryBudget = evaluateBudget(retryItems, constraints.partySize, constraints.budgetCents);
      if (retryItems.length && retryBudget.verdict !== 'breaks') {
        notices.push({ code: 'budget_repaired', message: `First pick was over budget (${budget.detail}) — swapped for cheaper options.` });
        selection = retry; items = retryItems; budget = retryBudget;
      }
    }
    if (budget.verdict === 'breaks') {
      const swapped = this.cheaperSelection(selection, ledger, constraints);
      if (swapped) {
        const swappedItems = await this.buildItems(swapped, ledger, constraints, [], context);
        const swappedBudget = evaluateBudget(swappedItems, constraints.partySize, constraints.budgetCents);
        if (swappedBudget.verdict !== 'breaks') {
          notices.push({ code: 'budget_repaired', message: `First pick was over budget (${budget.detail}) — swapped for cheaper options.` });
          selection = swapped; items = swappedItems; budget = swappedBudget;
        }
      }
    }
    return this.finalizePlan(constraints, items, ledger, selection, notices, meta, 'model', sizeSource);
  }

  /**
   * Ranked composition. For each requested need, in order: gather the need's
   * candidates with their bookables and travel from the previous stop, let the
   * ranker pick, then apply the budget in code (a prime that breaks it falls to
   * the next viable alternate). The model's selection is only consulted where
   * the ranker featured nothing, and is labeled a suggestion.
   */
  private async rankedPlan(ranker: NeedRanker, request: ConciergeRequest, constraints: PlanConstraints, ledger: Ledger, suggestions: PlanSelection | null,
    notices: Notice[], meta: ProposedPlan['meta'], context: SkillContext, sizeSource: ProposedPlan['partySizeSource']): Promise<ProposedPlan> {
    const window = { startsAt: constraints.startsAt, endsAt: constraints.endsAt };
    const partySize = constraints.partySize ?? ASSUMED_PARTY_SIZE;
    // Only the requester has committed to an unsaved proposal, and never more than the party.
    const goingCount = Math.min(1, partySize);
    const used = new Set<string>();
    // First stop: travel is known only from a location the guest actually gave (not the default area centre).
    let from: { latitude: number; longitude: number } | null = request.latitude !== undefined && request.longitude !== undefined ? { latitude: request.latitude, longitude: request.longitude } : null;
    type Decision = { need: string; candidate: Candidate; ranking: ItemRanking; order: string[]; primeId: string | null };
    const decisions: Decision[] = [];

    for (const need of constraints.needs) {
      if (!(DISCOVERY_NEEDS as readonly string[]).includes(need)) continue;
      const pool = [...ledger.candidates.values()].filter((c) => !used.has(c.id) && (c.needKind === need || (need === 'nightlife' && c.kind === 'event')));
      if (!pool.length) continue;
      const options: RankableOption[] = [];
      for (const candidate of pool) {
        const found = candidate.kind === 'place' && candidate.placeId ? await this.bookablesFor(candidate.placeId, ledger, constraints, notices, context) : null;
        options.push({
          candidate,
          bytspot: (found?.bytspot ?? []).map(({ fitsParty: _f, ...b }) => b),
          deeplinks: found?.deeplinks ?? [],
          travelMinutes: from ? await this.routeMinutes(from, candidate) : null,
        });
      }
      let ranking: NeedRanking;
      try {
        ranking = ranker.rank({ need, options, partySize, goingCount, window });
      } catch {
        notices.push({ code: 'prime_path', message: `Couldn't rank ${need} options right now, so none were featured.` });
        continue;
      }
      const name = (id: string) => ledger.candidates.get(id)?.name ?? id;
      for (const d of ranking.dropped) {
        const why = d.why === 'seats' ? `not enough open spots for ${partySize}` : d.why === 'min_party' ? 'it needs more people committed than have joined' : "it can't be confirmed for your time";
        notices.push({ code: 'prime_path', message: `Left out ${name(d.id)}: ${why}.` });
      }
      const order = [...ranking.rankedAlternateIds, ...ranking.unrankedIds].filter((id) => ledger.candidates.has(id));
      const ranked = new Set(ranking.rankedAlternateIds);
      const alternatesExcept = (...ids: string[]) => order.filter((id) => !ids.includes(id)).map((id) => ({ candidateId: id, title: name(id), ranked: ranked.has(id) }));
      let chosen: string | null = null;
      let itemRanking: ItemRanking;
      if (ranking.primeId && ranking.reason && ledger.candidates.has(ranking.primeId)) {
        chosen = ranking.primeId;
        itemRanking = { status: 'prime', reason: ranking.reason, note: null, alternates: alternatesExcept(chosen) };
      } else {
        const suggested = suggestions?.items.find((i) => order.includes(i.candidateId))?.candidateId ?? null;
        chosen = suggested ?? order[0] ?? null;
        if (!chosen) continue;
        itemRanking = suggested
          ? { status: 'suggestion', reason: null, note: 'Suggestion — not a Prime Path pick: nothing here can be confirmed in Bytspot, so check availability via the link.', alternates: alternatesExcept(chosen) }
          : { status: 'listed', reason: null, note: 'Not a Prime Path pick: nothing here can be confirmed in Bytspot. Listed by distance; check availability via the link.', alternates: alternatesExcept(chosen) };
      }
      const candidate = ledger.candidates.get(chosen)!;
      used.add(chosen);
      decisions.push({ need, candidate, ranking: itemRanking, order, primeId: ranking.primeId });
      from = { latitude: candidate.latitude, longitude: candidate.longitude };
    }

    // Budget still enforced in code after ranking: a prime that breaks it falls to the next viable alternate.
    const budgetOf = () => evaluateBudget(decisions.map((d) => d.candidate), constraints.partySize, constraints.budgetCents);
    let budget = budgetOf();
    if (budget.verdict === 'breaks') {
      const before = budget.detail;
      const primesFirst = [...decisions].sort((a, b) => Number(b.ranking.status === 'prime') - Number(a.ranking.status === 'prime'));
      for (const d of primesFirst) {
        const original = d.candidate;
        for (const id of d.order) {
          if (id === original.id || decisions.some((o) => o.candidate.id === id)) continue;
          d.candidate = ledger.candidates.get(id)!;
          if (budgetOf().verdict === 'fits') break;
          d.candidate = original;
        }
        if (d.candidate === original) continue;
        const ranked = new Set(d.ranking.alternates.filter((a) => a.ranked).map((a) => a.candidateId));
        const wasPrime = d.ranking.status === 'prime';
        const message = wasPrime
          ? `Prime Path pick ${original.name} is over your budget (${before}); using the next viable alternate, ${d.candidate.name}.`
          : `${original.name} is over your budget (${before}); using ${d.candidate.name} instead.`;
        d.ranking = {
          status: wasPrime ? 'fallback' : 'listed', reason: null, note: message,
          alternates: d.order.filter((id) => id !== d.candidate.id && id !== original.id).map((id) => ({ candidateId: id, title: ledger.candidates.get(id)!.name, ranked: ranked.has(id) || id === d.primeId })),
        };
        notices.push({ code: wasPrime ? 'prime_path' : 'budget_repaired', message });
        budget = budgetOf();
        if (budget.verdict === 'fits') break;
      }
    }

    const selection: PlanSelection = {
      title: suggestions?.title || constraints.intent,
      pitch: suggestions?.pitch ?? '',
      items: decisions.map((d) => {
        const timed = suggestions?.items.find((i) => i.candidateId === d.candidate.id);
        return { candidateId: d.candidate.id, startsAt: timed?.startsAt ?? null, durationMins: timed?.durationMins ?? null };
      }),
    };
    const items = await this.buildItems(selection, ledger, constraints, notices, context);
    for (const item of items) {
      const decision = decisions.find((d) => d.candidate.id === item.candidateId);
      if (!decision) continue;
      item.primePath = decision.ranking;
      item.needKind = decision.need; // a party found for "nightlife" is the nightlife stop
    }
    return this.finalizePlan(constraints, items, ledger, selection, notices, meta, 'prime_path', sizeSource);
  }

  private async bookablesFor(placeId: string, ledger: Ledger, constraints: PlanConstraints, notices: Notice[], context: SkillContext) {
    let found = ledger.bookables.get(placeId);
    if (!found) {
      found = await bookablesSkill.run({ placeId, partySize: constraints.partySize ?? undefined }, context);
      ledger.record('bookables', { placeId }, found);
      if (found.status === 'unavailable') notices.push({ code: 'provider_unavailable', message: found.message });
    }
    return found;
  }

  /** Routing estimate only; unknown stays null (never a guessed number). */
  private async routeMinutes(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }): Promise<number | null> {
    try {
      const est = await this.ports.routing.travel(from, to, estimateTravel(from, to).mode);
      return est ? est.minutes : null;
    } catch { return null; }
  }

  private async runSkill(name: string, args: unknown, context: SkillContext, ledger: Ledger): Promise<string> {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return JSON.stringify({ error: `Unknown skill "${name}".` });
    const input = skill.input.safeParse(args);
    if (!input.success) return JSON.stringify({ error: 'Invalid arguments', issues: input.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    try {
      const output = await skill.run(input.data, context);
      ledger.record(name, input.data, output);
      return JSON.stringify(output);
    } catch {
      return JSON.stringify({ error: `${name} failed; treat its data as unavailable.` });
    }
  }

  private async select(messages: ChatMessage[], ledger: Ledger, constraints: PlanConstraints, budgetProblem: string | null): Promise<PlanSelection | null> {
    const list = [...ledger.candidates.values()].map((c) => ({ id: c.id, needKind: c.needKind, name: c.name, priceCents: c.priceCents, priceBasis: c.priceBasis, startsAt: c.startsAt, distanceMeters: c.distanceMeters }));
    const ask = budgetProblem
      ? `That plan is over budget: ${budgetProblem} Pick cheaper candidates so the group total is within ${constraints.budgetCents} cents.`
      : 'Now propose the plan.';
    try {
      return await this.llm.structured({ name: 'plan_selection', schema: planSelectionSchema, messages: [
        ...messages,
        { role: 'user', content: `${ask} Use only these candidate ids, in visiting order:\n${JSON.stringify(list)}\nReturn JSON {title, pitch, items:[{candidateId, startsAt, durationMins}]}.` },
      ] });
    } catch { return null; }
  }

  /** Deterministic pick when the model is unavailable: nearest candidate per requested need. */
  private fallbackSelection(constraints: PlanConstraints, ledger: Ledger): PlanSelection {
    const items = constraints.needs.flatMap((need) => {
      const best = [...ledger.candidates.values()].filter((c) => c.needKind === need).sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
      return best ? [{ candidateId: best.id, startsAt: null, durationMins: null }] : [];
    });
    return { title: constraints.intent, pitch: '', items };
  }

  /** Swap the priciest stops for the cheapest priced candidate of the same kind until it fits. */
  private cheaperSelection(selection: PlanSelection, ledger: Ledger, constraints: PlanConstraints): PlanSelection | null {
    const items = selection.items.filter((i) => ledger.candidates.has(i.candidateId)).map((i) => ({ ...i }));
    const order = [...items.keys()].sort((a, b) => (ledger.candidates.get(items[b].candidateId)!.priceCents ?? 0) - (ledger.candidates.get(items[a].candidateId)!.priceCents ?? 0));
    let changed = false;
    for (const index of order) {
      const current = ledger.candidates.get(items[index].candidateId)!;
      const used = new Set(items.map((i) => i.candidateId));
      const cheapest = [...ledger.candidates.values()]
        .filter((c) => c.needKind === current.needKind && c.priceCents !== null && !used.has(c.id) && c.priceCents < (current.priceCents ?? Infinity))
        .sort((a, b) => a.priceCents! - b.priceCents!)[0];
      if (!cheapest) continue;
      items[index] = { candidateId: cheapest.id, startsAt: null, durationMins: null };
      changed = true;
      const check = evaluateBudget(items.map((i) => ledger.candidates.get(i.candidateId)!), constraints.partySize, constraints.budgetCents);
      if (check.verdict !== 'breaks') break;
    }
    return changed ? { ...selection, items } : null;
  }

  private async buildItems(selection: PlanSelection, ledger: Ledger, constraints: PlanConstraints, notices: Notice[], context: SkillContext): Promise<ProposedPlanItem[]> {
    const seen = new Set<string>();
    const picked: Array<{ candidate: Candidate; startsAt: string | null; durationMins: number | null }> = [];
    for (const item of selection.items) {
      const candidate = ledger.candidates.get(item.candidateId);
      if (!candidate) {
        notices.push({ code: 'dropped_unverified_item', message: `Left out "${item.candidateId}": no provider returned it, so it can't be verified.` });
        continue;
      }
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      picked.push({ candidate, startsAt: item.startsAt, durationMins: item.durationMins });
    }
    const travel = await travelBetween(this.ports, picked.map((p) => p.candidate));
    const schedule = scheduleStops({ startsAt: constraints.startsAt, endsAt: constraints.endsAt }, picked.map((p) => ({
      id: p.candidate.id, title: p.candidate.name,
      durationMins: p.candidate.durationMins ?? p.durationMins ?? DEFAULT_DURATION_MINS[p.candidate.needKind] ?? 90,
      fixedStartsAt: p.candidate.startsAt, preferredStartsAt: p.startsAt,
    })), travel);
    if (picked.some((p, i) => p.startsAt && !p.candidate.startsAt && schedule[i].timeSource === 'scheduled')) {
      notices.push({ code: 'schedule_adjusted', message: 'Some suggested times did not leave room for travel or fall in your window, so they were moved.' });
    }

    const items: ProposedPlanItem[] = [];
    for (const [position, { candidate }] of picked.entries()) {
      let booking: BookingOption[] = [];
      if (candidate.placeId) {
        let found = ledger.bookables.get(candidate.placeId);
        if (!found) {
          found = await bookablesSkill.run({ placeId: candidate.placeId, partySize: constraints.partySize ?? undefined }, context);
          ledger.record('bookables', { placeId: candidate.placeId }, found);
          if (found.status === 'unavailable') notices.push({ code: 'provider_unavailable', message: found.message });
        }
        booking = [...found.bytspot.map(({ fitsParty: _f, ...b }) => b), ...found.deeplinks];
      }
      if (candidate.kind === 'event' && candidate.bookableId && candidate.capability !== 'details') {
        // Bytspot supply (a party) books in-app through plans.createWithBookables. No price is invented.
        booking = [{ kind: 'bytspot', bookableId: candidate.bookableId, capability: candidate.capability, tierName: 'Party entry', priceCents: null, capacity: candidate.capacity }, ...booking.filter((b) => b.kind !== 'bytspot')];
      }
      const bookable = booking.find((b) => b.kind === 'bytspot');
      items.push({
        position, needKind: candidate.needKind, title: candidate.name, candidateId: candidate.id,
        placeId: candidate.placeId, placeName: candidate.name, placeAddress: candidate.address,
        placeLat: candidate.latitude, placeLng: candidate.longitude,
        startsAt: schedule[position].startsAt, durationMins: schedule[position].durationMins,
        timeSource: schedule[position].timeSource, travelMinsBefore: schedule[position].travelMinsBefore,
        priceCents: candidate.priceCents, priceBasis: candidate.priceBasis,
        capability: bookable ? (bookable.capability === 'request' ? 'request' : 'book') : 'details',
        crowd: candidate.crowd, booking, primePath: null,
        rides: (this.ports.routing.rideLinks ?? rideLinks)({ latitude: candidate.latitude, longitude: candidate.longitude, name: candidate.name, address: candidate.address }),
      });
    }
    return items;
  }

  private finalizePlan(constraints: PlanConstraints, items: ProposedPlanItem[], ledger: Ledger, selection: PlanSelection, notices: Notice[], meta: ProposedPlan['meta'], ranking: ProposedPlan['ranking'], sizeSource: ProposedPlan['partySizeSource']): ProposedPlan {
    const window = { startsAt: constraints.startsAt, endsAt: constraints.endsAt };
    const budget = evaluateBudget(items, constraints.partySize, constraints.budgetCents);
    const checks = [
      ...scheduleChecks(window, items.map((i) => ({ id: i.candidateId, title: i.title, startsAt: i.startsAt, durationMins: i.durationMins, travelMinsBefore: i.travelMinsBefore, timeSource: i.timeSource,
        endsAt: i.startsAt && i.durationMins !== null ? new Date(new Date(i.startsAt).getTime() + i.durationMins * 60_000).toISOString() : null }))),
      { check: 'budget' as const, verdict: budget.verdict, detail: budget.detail },
      capacityCheck(constraints.partySize, items.map((i) => ({ title: i.title, seats: ledger.candidates.get(i.candidateId)?.capacity ?? null }))),
    ];
    const verdict = overallVerdict(checks);

    if (budget.verdict === 'breaks') notices.push({ code: 'over_budget', message: `Over budget: ${budget.detail} Edit a stop or raise the budget before booking.` });
    for (const c of checks) if (c.verdict === 'breaks' && c.check !== 'budget') notices.push({ code: 'schedule_infeasible', message: c.detail });
    if (!items.length) notices.push({ code: 'no_options', message: "I couldn't find verified options for this yet. Try a different area, time or budget." });
    if (items.some((i) => i.crowd?.source === 'typical')) notices.push({ code: 'typical_not_live', message: 'Crowd levels marked typical are usual patterns, not live counts.' });
    if (items.some((i) => i.booking.some((b) => b.kind === 'deeplink'))) notices.push({ code: 'deeplink_only', message: 'OpenTable/Resy links open the provider; table availability was not checked.' });
    if (items.length) notices.push({ code: 'deeplink_only', message: 'Uber/Lyft links are hand-offs; fares were not checked.' });
    if (budget.basis === 'estimate') notices.push({ code: 'price_estimate', message: 'Some prices are estimates, not quotes.' });
    if (items.some((i) => i.priceCents === null)) notices.push({ code: 'price_unknown', message: 'Some stops have no known price.' });

    const fallbackSummary = this.summarize(items, budget.perPersonCents, budget.totalCents, constraints.partySize, budget.basis === 'estimate');
    let summary = selection.pitch?.trim() || fallbackSummary;
    // Ranked plans: the model's text may not name a stop the ranker did not pick.
    const inPlan = new Set(items.map((i) => i.candidateId));
    const namesUnpicked = ranking === 'prime_path' && [...ledger.candidates.values()].some((c) => !inPlan.has(c.id) && !items.some((i) => i.title.includes(c.name)) && summary.includes(c.name));
    if (summary !== fallbackSummary && (namesUnpicked || honestyViolations(summary, this.honestyFacts(items, constraints, budget.perPersonCents, budget.totalCents)).length)) {
      notices.push({ code: 'text_replaced', message: "The assistant's description made a claim the data doesn't support, so it was replaced with a plain summary." });
      summary = fallbackSummary;
    }
    const sizeUnconfirmed = sizeSource === 'assumed';
    const status: ProposedPlan['status'] = verdict === 'breaks' || !items.length || sizeUnconfirmed ? 'needs_changes' : 'proposed';
    const bookable = items.some((i) => i.booking.length > 0);
    return {
      kind: 'plan', status, lifecycle: 'proposed', ...constraints,
      title: selection.title || constraints.intent, summary, items,
      feasibility: { verdict, checks }, budget,
      notices: dedupe(notices),
      actions: {
        edit: { available: true },
        share: { available: items.length > 0, via: 'plans.create' },
        book: sizeUnconfirmed
          ? { available: false, reason: PARTY_SIZE_UNCONFIRMED }
          : { available: status === 'proposed' && bookable, reason: status !== 'proposed' ? 'Fix the flagged checks first.' : bookable ? null : 'No bookable stops; these are walk-in or details only.' },
      },
      meta,
      ranking,
      partySizeSource: sizeSource,
    };
  }

  private async quick(request: ConciergeRequest, constraints: PlanConstraints, ledger: Ledger, messages: ChatMessage[], notices: Notice[], meta: QuickAnswer['meta'], llmUp: boolean): Promise<QuickAnswer> {
    const candidates = [...ledger.candidates.values()];
    const fallback = candidates.length
      ? `Nearby: ${candidates.slice(0, 3).map((c) => `${c.name}${c.crowd ? ` (${c.crowd.label})` : ''}`).join('; ')}.`
      : "I couldn't check that right now.";
    let answer = fallback;
    if (llmUp) {
      try {
        answer = (await this.llm.structured({ name: 'quick_answer', schema: quickAnswerSchema, messages: [...messages, { role: 'user', content: 'Answer in one or two sentences using only the skill results above. JSON {answer}.' }] })).answer;
      } catch { answer = fallback; }
    }
    const facts = { liveNames: candidates.filter((c) => c.crowd?.source === 'live').map((c) => c.name), otherNames: candidates.filter((c) => c.crowd?.source !== 'live').map((c) => c.name),
      allowedCents: candidates.flatMap((c) => (c.priceCents === null ? [] : [c.priceCents])) };
    if (answer !== fallback && honestyViolations(answer, facts).length) {
      notices.push({ code: 'text_replaced', message: "The assistant's answer made a claim the data doesn't support, so it was replaced." });
      answer = fallback;
    }
    const unavailable = notices.filter((n) => n.code === 'provider_unavailable' || n.code === 'assistant_unavailable');
    if (unavailable.length && !/unavailable/i.test(answer)) answer = `${answer} ${unavailable.map((n) => n.message).join(' ')}`;
    if (candidates.some((c) => c.crowd?.source === 'typical')) notices.push({ code: 'typical_not_live', message: 'Crowd levels marked typical are usual patterns, not live counts.' });
    return {
      kind: 'quick_answer', answer: answer.trim(), notices: dedupe(notices),
      makePlanSuggestion: { label: 'Make it a plan', prefill: { ...constraints, needs: constraints.needs.length ? constraints.needs : [...new Set(candidates.map((c) => c.needKind))] } },
      meta,
    };
  }

  private honestyFacts(items: ProposedPlanItem[], constraints: PlanConstraints, perPerson: number | null, total: number | null) {
    const allowed = [perPerson, total, constraints.budgetCents,
      constraints.budgetCents !== null && constraints.partySize ? Math.round(constraints.budgetCents / constraints.partySize) : null,
      ...items.flatMap((i) => (i.priceCents === null ? [] : [i.priceCents, constraints.partySize ? i.priceCents * constraints.partySize : null]))]
      .filter((v): v is number => v !== null);
    return { liveNames: items.filter((i) => i.crowd?.source === 'live').map((i) => i.title), otherNames: items.filter((i) => i.crowd?.source !== 'live').map((i) => i.title), allowedCents: allowed };
  }

  private summarize(items: ProposedPlanItem[], perPerson: number | null, total: number | null, partySize: number | null, estimate: boolean): string {
    if (!items.length) return 'No verified stops yet.';
    const stops = items.map((i, n) => `${n === 0 ? '' : 'then '}${i.needKind === 'dining' ? 'dinner at ' : i.needKind === 'drinks' ? 'drinks at ' : ''}${i.title}${i.startsAt ? ` (${clockLabel(i.startsAt)})` : ''}`).join(', ');
    const cost = perPerson !== null ? ` About ${money(perPerson)} each${total !== null && partySize ? `, ${money(total)} for ${partySize}` : ''}${estimate ? ' (estimate)' : ''}.` : '';
    return `${stops.charAt(0).toUpperCase()}${stops.slice(1)}.${cost}`;
  }
}

export const createEngine = (options: EngineOptions) => new ByttSiEngine(options);
