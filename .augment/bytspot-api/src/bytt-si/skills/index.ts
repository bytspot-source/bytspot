import { bestTimeToGoSkill } from './bestTime';
import { bookablesSkill } from './bookables';
import { budgetSkill } from './budget';
import { discoverySkill } from './discovery';
import { peopleSkill } from './people';
import { routingSkill } from './routing';
import { schedulingSkill } from './scheduling';
import type { Skill } from './types';

export { bestTimeToGoSkill, bookablesSkill, budgetSkill, discoverySkill, peopleSkill, routingSkill, schedulingSkill };
export { candidateSchema, type Candidate } from './discovery';
export { travelBetween } from './scheduling';
export * from './types';

/** The BYTT-SI skills, exposed to the model as tools. */
export const SKILLS: readonly Skill[] = [discoverySkill, budgetSkill, peopleSkill, schedulingSkill, routingSkill, bookablesSkill, bestTimeToGoSkill] as unknown as Skill[];
