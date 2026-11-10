import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';

/**
 * REA review 2026-11-10, X6 and P1: the 21+ rule was stored on the party
 * (`templateConfig.hostAge`) but never enforced, and nobody's age was known.
 *
 * Age is self-declared: a date of birth, or a bare "I am 18 or older"
 * confirmation. It is a gate, not verification; 21+ passes still say
 * "21+ / ID required" and the door checks ID. Rules:
 *   - all-ages parties: nothing required
 *   - 18-plus parties, private sales: 18+ by birth date or confirmation
 *   - 21-plus parties and any bottle (alcohol) session: 21+ by birth date
 *   - a birth date under MIN_SIGNUP_AGE refuses the account outright
 */
export type AgeRule = 'all-ages' | '18-plus' | '21-plus';

export interface AgeFacts {
  birthDate: Date | null;
  ageConfirmedAt: Date | null;
}

export function ageInYears(birthDate: Date, now = new Date()): number {
  // Calendar age in UTC: a @db.Date column comes back as UTC midnight.
  let years = now.getUTCFullYear() - birthDate.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < birthDate.getUTCMonth()
    || (now.getUTCMonth() === birthDate.getUTCMonth() && now.getUTCDate() < birthDate.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years;
}

/** The youngest age these facts prove, or null when nothing is known. */
export function provenMinimumAge(facts: AgeFacts, now = new Date()): number | null {
  if (facts.birthDate) return ageInYears(facts.birthDate, now);
  if (facts.ageConfirmedAt) return 18;
  return null;
}

export function partyAgeRule(templateConfig: unknown): AgeRule {
  const value = templateConfig && typeof templateConfig === 'object' ? (templateConfig as { hostAge?: unknown }).hostAge : undefined;
  return value === '18-plus' || value === '21-plus' ? value : 'all-ages';
}

export function minimumAgeFor(rule: AgeRule, buysAlcohol = false): number {
  if (buysAlcohol || rule === '21-plus') return 21;
  if (rule === '18-plus') return 18;
  return 0;
}

/** Why these facts fail the minimum, as something a guest can act on, or null. */
export function ageProblem(facts: AgeFacts, minimumAge: number, now = new Date()): string | null {
  if (minimumAge <= 0) return null;
  const proven = provenMinimumAge(facts, now);
  if (minimumAge >= 21) {
    if (!facts.birthDate) return 'This is 21+. Add your date of birth in your account to continue. ID is checked at the door.';
    return (proven ?? 0) >= 21 ? null : 'This is 21+ only.';
  }
  if (proven === null) return `This is ${minimumAge}+. Confirm your age in your account to continue.`;
  return proven >= minimumAge ? null : `This is ${minimumAge}+ only.`;
}

export async function assertMemberAge(userId: string, minimumAge: number, now = new Date()): Promise<void> {
  if (minimumAge <= 0) return;
  const user = await db.user.findUnique({ where: { id: userId }, select: { birthDate: true, ageConfirmedAt: true } });
  const problem = ageProblem({ birthDate: user?.birthDate ?? null, ageConfirmedAt: user?.ageConfirmedAt ?? null }, minimumAge, now);
  if (problem) throw new TRPCError({ code: 'FORBIDDEN', message: problem });
}

/** A YYYY-MM-DD birth date a signup or settings form may store, or a reason it may not. */
export function parseBirthDate(value: string, now = new Date()): { date: Date } | { problem: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { problem: 'Use the format YYYY-MM-DD.' };
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    return { problem: 'That date does not exist.' };
  }
  const age = ageInYears(date, now);
  if (age > 120 || date > now) return { problem: 'Enter your real date of birth.' };
  if (age < config.minSignupAge) return { problem: `You must be ${config.minSignupAge} or older to use Bytspot.` };
  return { date };
}

/** A bottle session sells alcohol whenever it names bottles. */
export function sessionSellsAlcohol(session: { bottleCount: number } | null | undefined): boolean {
  return Boolean(session && session.bottleCount > 0);
}

/** Why this business may not sell a bottle session, or null. */
export function alcoholLicenceProblem(seller: { alcoholLicenceVerifiedAt: Date | null } | null | undefined): string | null {
  return seller?.alcoholLicenceVerifiedAt
    ? null
    : 'Bottle sessions need an alcohol licence Bytspot has verified for this business. Contact Bytspot to add one.';
}
