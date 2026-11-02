import { z } from 'zod';
import { DEFAULT_RADIUS_MILES, MIDTOWN, type ConciergeRequest, type Notice, type PlanConstraints } from '../types';

const iso = z.iso.datetime({ offset: true });

/** What the model extracts from the request (structured output "intent"). */
export const intentSchema = z.object({
  mode: z.enum(['plan', 'quick']).describe('quick = a short factual question; plan = anything that should become a night plan.'),
  intent: z.string().min(1).describe('One short phrase, e.g. "dinner and drinks".'),
  needs: z.array(z.string()).default([]).describe('Ordered stop kinds: dining, drinks, nightlife, event, coffee, activity.'),
  startsAt: iso.nullable().default(null),
  endsAt: iso.nullable().default(null),
  areaLabel: z.string().nullable().default(null),
  partySize: z.number().int().min(1).max(50).nullable().default(null),
  budgetPerPersonCents: z.number().int().min(0).nullable().default(null),
  budgetTotalCents: z.number().int().min(0).nullable().default(null),
  radiusMiles: z.number().positive().max(25).nullable().default(null),
  preferences: z.array(z.string()).default([]),
});
export type ParsedIntent = z.infer<typeof intentSchema>;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = (s: string) => WORD_NUMBERS[s.toLowerCase()] ?? Number(s);

/**
 * Code-side reading of money and head count. When it finds something it wins
 * over the model: the budget check must not depend on the model reading "$60 each" right.
 */
export function parseMoneyAndParty(message: string): { perPersonCents: number | null; totalCents: number | null; partySize: number | null } {
  const text = message.toLowerCase();
  const pp = text.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*(?:each|per person|per head|a head|a person|pp|\/\s?person|\/\s?head)/)
    ?? text.match(/(?:under|below|max|up to|less than)\s*\$\s?(\d+(?:\.\d{1,2})?)\s*(?:each|per person|pp|a head|a person)/);
  const total = text.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*(?:total|in total|all in|for (?:all of us|everyone|the group))/);
  const party = text.match(/\b(?:for|party of|group of)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b(?!\s*(?:am|pm|:|\$|o'clock))/)
    ?? text.match(/\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+of us\b/);
  return {
    perPersonCents: pp ? Math.round(Number(pp[1]) * 100) : null,
    totalCents: total ? Math.round(Number(total[1]) * 100) : null,
    partySize: party ? num(party[1]) : null,
  };
}

export function normalizeConstraints(parsed: ParsedIntent | null, request: ConciergeRequest): { constraints: PlanConstraints; notices: Notice[] } {
  const notices: Notice[] = [];
  const code = parseMoneyAndParty(request.message);
  const partySize = code.partySize ?? parsed?.partySize ?? null;
  const perPerson = code.perPersonCents ?? (code.totalCents === null ? parsed?.budgetPerPersonCents ?? null : null);
  const total = code.totalCents ?? (code.perPersonCents === null ? parsed?.budgetTotalCents ?? null : null);
  let budgetCents: number | null = total;
  if (budgetCents === null && perPerson !== null) {
    if (partySize) budgetCents = perPerson * partySize;
    else notices.push({ code: 'assumption', message: 'Tell me how many people to check the per-person budget.' });
  }

  let latitude = request.latitude ?? null; let longitude = request.longitude ?? null;
  let areaLabel = parsed?.areaLabel ?? request.areaLabel ?? null;
  if (latitude === null || longitude === null) {
    if (areaLabel && !/midtown/i.test(areaLabel)) {
      notices.push({ code: 'assumption', message: `Bytspot covers Midtown Atlanta for now, so this plan is around Midtown, not ${areaLabel}.` });
    } else if (!areaLabel) {
      notices.push({ code: 'assumption', message: 'No area given, so this plan is around Midtown Atlanta.' });
    }
    ({ latitude, longitude } = MIDTOWN); areaLabel = MIDTOWN.areaLabel;
  }

  let startsAt = parsed?.startsAt ?? null; let endsAt = parsed?.endsAt ?? null;
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    notices.push({ code: 'assumption', message: 'The end time was before the start time, so it was dropped.' });
    endsAt = null;
  }
  return {
    notices,
    constraints: {
      intent: parsed?.intent ?? 'night out',
      startsAt, endsAt, areaLabel, latitude, longitude, partySize, budgetCents,
      radiusMiles: parsed?.radiusMiles ?? DEFAULT_RADIUS_MILES,
      needs: parsed?.needs?.length ? parsed.needs : [],
      preferences: [...new Set([...(parsed?.preferences ?? []), ...(request.preferences ?? [])])],
    },
  };
}
