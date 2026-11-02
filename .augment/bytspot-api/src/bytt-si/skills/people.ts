import { z } from 'zod';
import { defineSkill, statusSchema } from './types';

const input = z.object({
  names: z.array(z.string().min(1).max(80)).max(20).default([]).describe('Names the guest mentioned ("with Ama and Kofi"). Empty = their usual circle.'),
});
const output = z.object({
  status: statusSchema,
  message: z.string().nullable(),
  members: z.array(z.object({ userId: z.string(), displayName: z.string(), preferences: z.array(z.string()) })),
  unresolved: z.array(z.string()),
  preferences: z.array(z.string()),
  partySizeHint: z.number().int().nullable(),
});

export const peopleSkill = defineSkill({
  name: 'people',
  description: "Look up the guest's group (friends/circle on Bytspot) and their combined preferences such as dietary needs. Never guess people who are not returned.",
  input, output,
  async run(args, { ports, userId }) {
    if (!userId) return { status: 'none' as const, message: 'No signed-in guest, so no group to look up.', members: [], unresolved: args.names, preferences: [], partySizeHint: null };
    try {
      const { members, unresolved } = await ports.people.group(userId, args.names);
      const preferences = [...new Set(members.flatMap((m) => m.preferences))].sort();
      return {
        status: members.length ? 'ok' as const : 'none' as const,
        message: unresolved.length ? `Couldn't find ${unresolved.join(', ')} on Bytspot.` : null,
        members, unresolved, preferences,
        partySizeHint: members.length + unresolved.length + 1,
      };
    } catch {
      return { status: 'unavailable' as const, message: 'Group lookup is unavailable right now.', members: [], unresolved: args.names, preferences: [], partySizeHint: null };
    }
  },
});
