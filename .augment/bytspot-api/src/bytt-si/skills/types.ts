import { z } from 'zod';
import type { ToolDefinition } from '../llm/types';
import type { Ports } from '../ports/types';

/** Defaults the engine passes to every skill, from the parsed request. */
export interface SkillContext {
  ports: Ports;
  userId: string | null;
  /** Request clock (ISO). Used to age live readings. */
  now: string;
  defaults: {
    latitude: number; longitude: number; radiusMiles: number;
    startsAt: string | null; endsAt: string | null;
    partySize: number | null; budgetCents: number | null;
  };
}

export interface Skill<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  /** Used verbatim as the LLM tool description. */
  description: string;
  input: I;
  output: O;
  run(input: z.output<I>, context: SkillContext): Promise<z.output<O>>;
}

export const defineSkill = <I extends z.ZodType, O extends z.ZodType>(skill: Skill<I, O>): Skill<I, O> => skill;

export function toToolDefinition(skill: Skill): ToolDefinition {
  const parameters = z.toJSONSchema(skill.input, { io: 'input' }) as Record<string, unknown>;
  delete parameters.$schema;
  return { name: skill.name, description: skill.description, parameters };
}

export const latLngSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
export const isoDateTime = z.iso.datetime({ offset: true });
export const statusSchema = z.enum(['ok', 'stale', 'none', 'unavailable']);
