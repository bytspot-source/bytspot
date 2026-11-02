import { bookablesSkill } from './bookables';
import { budgetSkill } from './budget';
import { discoverySkill } from './discovery';
import { peopleSkill } from './people';
import { routingSkill } from './routing';
import { schedulingSkill } from './scheduling';
import type { Skill } from './types';

export { bookablesSkill, budgetSkill, discoverySkill, peopleSkill, routingSkill, schedulingSkill };
export { candidateSchema, type Candidate } from './discovery';
export { travelBetween } from './scheduling';
export * from './types';

/** The six BYTT-SI skills, exposed to the model as tools. */
export const SKILLS: readonly Skill[] = [discoverySkill, budgetSkill, peopleSkill, schedulingSkill, routingSkill, bookablesSkill] as unknown as Skill[];
