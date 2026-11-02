import type { PeoplePort } from '../ports/types';

/**
 * PeoplePort over the caller's own social circles (SocialCircle /
 * SocialCircleMember), minus anyone blocked either way (safety.blockedUserIds).
 *
 * Other members' preferences are NOT shared with the planner: UserPreference is
 * personal data the member never agreed to show a friend's concierge. Only the
 * caller's own preferences reach the model (via the request).
 */
export interface PeopleAdapterDeps {
  circleMembers(userId: string): Promise<Array<{ userId: string; name: string | null }>>;
  blocked(userId: string): Promise<Set<string>>;
}

const norm = (s: string) => s.trim().toLowerCase();

export function createBackendPeoplePort(deps: PeopleAdapterDeps): PeoplePort {
  return {
    async group(userId, names) {
      const [members, blocked] = await Promise.all([deps.circleMembers(userId), deps.blocked(userId)]);
      const visible = members.filter((m) => m.userId !== userId && !blocked.has(m.userId) && m.name?.trim());
      const unique = [...new Map(visible.map((m) => [m.userId, m])).values()];
      const toPerson = (m: { userId: string; name: string | null }) => ({ userId: m.userId, displayName: m.name!.trim(), preferences: [] as string[] });
      if (!names.length) return { members: unique.slice(0, 20).map(toPerson), unresolved: [] };
      const found = new Map<string, { userId: string; name: string | null }>();
      const unresolved: string[] = [];
      for (const name of names) {
        const n = norm(name);
        const match = unique.find((m) => norm(m.name!) === n || norm(m.name!).split(/\s+/)[0] === n);
        if (match) found.set(match.userId, match); else unresolved.push(name);
      }
      return { members: [...found.values()].map(toPerson), unresolved };
    },
  };
}
