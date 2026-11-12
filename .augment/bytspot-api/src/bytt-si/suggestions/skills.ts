import { z } from 'zod';
import type { ToolDefinition } from '../llm/types';
import { SUGGESTION_NEEDS, type SuggestionFacts } from './types';

export interface SuggestionSkillContext { facts: SuggestionFacts }

interface SuggestionSkill<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  description: string;
  input: I;
  output: O;
  run(input: z.output<I>, context: SuggestionSkillContext): Promise<z.output<O>>;
}

const none = z.object({}).strict();

const contextOutput = z.object({
  hour: z.number().int(),
  dayOfWeek: z.number().int(),
  weekday: z.string(),
  area: z.object({ label: z.string().nullable(), basis: z.enum(['coordinates', 'launch_market']), sentence: z.string() }).strict(),
  typical: z.object({
    coffee: z.object({ level: z.number(), label: z.string() }).strict().nullable(),
    restaurant: z.object({ level: z.number(), label: z.string() }).strict().nullable(),
    bar: z.object({ level: z.number(), label: z.string() }).strict().nullable(),
    barNight: z.object({ level: z.number(), label: z.string() }).strict().nullable(),
    venue: z.object({ level: z.number(), label: z.string() }).strict().nullable(),
  }).strict(),
  nightHour: z.number().int(),
}).strict();

const plansOutput = z.object({
  plans: z.array(z.object({
    id: z.string(), title: z.string(), startsAt: z.string().nullable(), areaLabel: z.string().nullable(),
  }).strict()),
}).strict();

const historyOutput = z.object({ needs: z.array(z.string()) }).strict();

const primeOutput = z.object({
  status: z.enum(['ok', 'unavailable']),
  confirmableNeeds: z.array(z.enum(SUGGESTION_NEEDS)),
}).strict();

/**
 * Facts the model may ask for. Each skill returns only what was already loaded
 * for this request, so a tool call cannot widen the clock, the area, or Prime Path.
 */
export const suggestionSkills = [
  {
    name: 'context',
    description: 'Local time in Atlanta, the area this request may name, and typical busyness. Typical is the usual level for that hour, never a live reading. Launch-market area means the guest did not share a location.',
    input: none,
    output: contextOutput,
    async run(_input, { facts }) {
      return {
        hour: facts.clock.hour, dayOfWeek: facts.clock.dayOfWeek, weekday: facts.clock.weekday,
        area: facts.area, typical: facts.typical, nightHour: facts.nightHour,
      };
    },
  },
  {
    name: 'plans',
    description: 'The guest\'s own upcoming Plans: id, title, start, and area. Empty when they have none. Never invent a plan.',
    input: none,
    output: plansOutput,
    async run(_input, { facts }) {
      return { plans: facts.plans };
    },
  },
  {
    name: 'history',
    description: 'Need kinds from the guest\'s recent Plans, such as coffee or nightlife. Empty when there is no history.',
    input: none,
    output: historyOutput,
    async run(_input, { facts }) {
      return { needs: facts.recentNeeds };
    },
  },
  {
    name: 'prime_path',
    description: 'Needs Prime Path can feature from confirmable Bytspot supply for this guest. status unavailable means the check did not run, not that nothing is confirmable. Do not name venues.',
    input: none,
    output: primeOutput,
    async run(_input, { facts }) {
      return facts.primePath;
    },
  },
] as const satisfies readonly SuggestionSkill<z.ZodType, z.ZodType>[];

export function suggestionToolDefinitions(): ToolDefinition[] {
  return suggestionSkills.map((skill) => {
    const parameters = z.toJSONSchema(skill.input, { io: 'input' }) as Record<string, unknown>;
    delete parameters.$schema;
    return { name: skill.name, description: skill.description, parameters };
  });
}

export async function runSuggestionSkill(name: string, args: unknown, context: SuggestionSkillContext): Promise<string> {
  const skill = suggestionSkills.find((item) => item.name === name);
  if (!skill) return JSON.stringify({ status: 'unavailable', message: 'Unknown skill.' });
  const parsed = skill.input.safeParse(args ?? {});
  if (!parsed.success) return JSON.stringify({ status: 'unavailable', message: 'Those arguments are not valid for this skill.' });
  try {
    return JSON.stringify(skill.output.parse(await skill.run(parsed.data, context)));
  } catch {
    return JSON.stringify({ status: 'unavailable', message: 'That skill is unavailable right now.' });
  }
}
