import { z } from 'zod';

/**
 * REA review 2026-11-10, X4 (Apple Guideline 1.2: "a method for filtering
 * objectionable material"). A deliberately small, deterministic first pass
 * over member-written text: titles, taglines, request notes, sale titles,
 * Plan titles and reviews.
 *
 * It is a floor, not a moderation system. Reports, auto-hide and the admin
 * queue remain the backstop. The implementation is swappable: call
 * `setContentFilter()` at startup with, for example, an adapter over the
 * OpenAI moderation endpoint, and every call site below picks it up. It is
 * synchronous on purpose so it can run inside zod input parsing; an async
 * provider should run alongside it at the call site, not replace it.
 *
 * Images are not covered here (party media, sale photos). See FIXES.md.
 */
export type FilterCategory = 'slur' | 'sexual-minors' | 'threat' | 'contact-info';

export interface FilterContext {
  /** Notes to performers and sale titles must not carry phone numbers, emails or pay handles. */
  blockContactInfo?: boolean;
}

export interface FilterResult {
  ok: boolean;
  categories: FilterCategory[];
}

export interface ContentFilter {
  check(text: string, context?: FilterContext): FilterResult;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b' };

/** Lower-case, de-leet, strip accents, and join letters split by single separators ("n.i.g" -> "nig"). */
export function normalizeForFilter(text: string): string {
  const lowered = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[0134578!@$]/g, (c) => LEET[c] ?? c);
  return lowered
    .replace(/\b([a-z])[\s._\-*]+(?=[a-z]\b)/g, '$1')
    .replace(/([a-z])\1{2,}/g, '$1$1');
}

// Stems matched at word starts. Kept short and high-confidence to avoid
// refusing ordinary words; extend in review, never by guessing.
const SLUR_PATTERNS: RegExp[] = [
  /\bn[i1]gg(?:a|er|ah|uh|az|ers)?\b/,
  /\bf[a4]gg?(?:ot|ots|y)?\b/,
  /\bk[iy]kes?\b/,
  /\bsp[i1]cks?\b/,
  /\bch[i1]nks?\b/,
  /\btr[a4]nn(?:y|ies)\b/,
  /\bwetbacks?\b/,
  /\bretards?\b/,
];
const SEXUAL_MINORS_PATTERNS: RegExp[] = [
  /\b(?:jail ?bait|lolis?|loli ?con|shota|cp\s*(?:links?|trade|for sale))\b/,
  /\b(?:under ?age|minors?|teens?|kids?)\b.{0,20}\b(?:nudes?|sex|porn|naked|onlyfans)\b/,
  /\b(?:nudes?|sex|porn|naked)\b.{0,20}\b(?:under ?age|minors?|kids?)\b/,
];
const THREAT_PATTERNS: RegExp[] = [
  /\b(?:i(?:'| a)?m|i will|ima|gonna|going to)\s+(?:kill|shoot|stab)\s+(?:you|u|him|her|them|everyone)\b/,
  /\bshoot (?:up|this) (?:the )?(?:party|place|club|school)\b/,
  /\bbomb (?:threat|the (?:party|place|club))\b/,
];
const CONTACT_PATTERNS: RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
  /\b(?:venmo|cash ?app|zelle|paypal|whats ?app|telegram|snap(?:chat)?)\s*(?:me|@|:|\$)/i,
  /(?:^|\s)\$[a-z][a-z0-9_-]{2,}/i,
];

export const keywordContentFilter: ContentFilter = {
  check(text, context = {}) {
    const categories = new Set<FilterCategory>();
    const normalized = normalizeForFilter(text);
    if (SLUR_PATTERNS.some((p) => p.test(normalized))) categories.add('slur');
    if (SEXUAL_MINORS_PATTERNS.some((p) => p.test(normalized))) categories.add('sexual-minors');
    if (THREAT_PATTERNS.some((p) => p.test(normalized))) categories.add('threat');
    // Contact details are read from the original text: de-leeting turns
    // digits into letters and would hide a phone number.
    if (context.blockContactInfo && CONTACT_PATTERNS.some((p) => p.test(text))) categories.add('contact-info');
    return { ok: categories.size === 0, categories: [...categories] };
  },
};

let active: ContentFilter = keywordContentFilter;

/** Swap the filter (tests, or a provider-backed one at startup). Returns the previous one. */
export function setContentFilter(filter: ContentFilter): ContentFilter {
  const previous = active;
  active = filter;
  return previous;
}

export function checkText(text: string, context?: FilterContext): FilterResult {
  return active.check(text, context);
}

export function filterMessage(categories: FilterCategory[]): string {
  if (categories.includes('contact-info')) return 'Keep phone numbers, emails and payment handles out of this. Bytspot shares contact details only when both sides agree.';
  return "This text can't be posted on Bytspot. Edit it and try again.";
}

/** A zod string schema that refuses text the active filter rejects. */
export function filteredText<T extends z.ZodType<string>>(schema: T, context?: FilterContext) {
  return schema.superRefine((value, ctx) => {
    if (!value) return;
    const result = checkText(value, context);
    if (!result.ok) ctx.addIssue({ code: 'custom', message: filterMessage(result.categories) });
  });
}
