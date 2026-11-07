/**
 * How iOS should present a push: how hard it may interrupt, how it ranks in
 * the notification summary, which conversation it stacks under, and which
 * action buttons it carries.
 *
 * Time Sensitive is kept for what is about to happen to this member: a Party
 * or Plan in 30 minutes, or a stop on today's Plan turning busy. Updates about
 * other people's activity are passive, so they wait in the summary instead of
 * lighting the screen. A device without the Time Sensitive entitlement reads
 * `time-sensitive` as `active`, so the level is safe to send before the app
 * ships it.
 */

export type InterruptionLevel = 'passive' | 'active' | 'time-sensitive';

/** Category identifiers the app registers with action buttons. */
export type PushActionCategory = 'PARTY_REMINDER';

export interface PushPresentation {
  interruptionLevel: InterruptionLevel;
  relevanceScore: number;
  category?: PushActionCategory;
}

const PASSIVE = new Set([
  'party.rsvp',
  'party.recap',
  'plan.item_added',
  'plan.joined',
  'plan.changed',
  'feedback.request',
]);

export function pushPresentation(type: string, stage?: '24h' | '2h' | '30m'): PushPresentation {
  if (type === 'reminder.party' || type === 'reminder.plan') {
    const category = type === 'reminder.party' ? { category: 'PARTY_REMINDER' as const } : {};
    if (stage === '30m') return { interruptionLevel: 'time-sensitive', relevanceScore: 1, ...category };
    if (stage === '24h') return { interruptionLevel: 'passive', relevanceScore: 0.4, ...category };
    return { interruptionLevel: 'active', relevanceScore: 0.8, ...category };
  }
  if (type === 'plan-stop-busy') return { interruptionLevel: 'time-sensitive', relevanceScore: 0.9 };
  if (PASSIVE.has(type)) return { interruptionLevel: 'passive', relevanceScore: 0.3 };
  return { interruptionLevel: 'active', relevanceScore: 0.6 };
}

/**
 * Pushes about the same Party, Plan or venue stack together on the lock
 * screen. Read from the route the push already opens, so no sender has to
 * name a thread.
 */
export function pushThreadId(url: string): string | undefined {
  try {
    const [kind, id] = new URL(url).pathname.split('/').filter(Boolean);
    if (!id || !['party', 'plan', 'venue'].includes(kind)) return undefined;
    return `${kind}:${decodeURIComponent(id)}`;
  } catch {
    return undefined;
  }
}
