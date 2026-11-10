import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';
import { normalizeForFilter } from '../lib/contentFilter';

/**
 * REA review 2026-11-10, PS1. What may be listed as a private sale, and for
 * how much. The user-facing rules live in
 * bytspot-beta/docs/legal-drafts/private-sales-prohibited-items.md (a DRAFT
 * for attorney review). This list is the enforcement side and should be kept
 * in step with it once counsel signs off.
 */
export const SALE_CATEGORIES = ['clothing', 'electronics', 'home', 'collectibles', 'sports', 'books-media', 'event-ticket', 'other'] as const;
export type SaleCategory = (typeof SALE_CATEGORIES)[number];

/** Prohibited item families. Matched on normalized title words. */
export const PROHIBITED_ITEMS: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
  {
    id: 'alcohol', label: 'Alcohol',
    pattern: /\b(alcohol|liquor|vodka|tequila|whiskey|whisky|bourbon|rum|gin|champagne|cognac|hennessy|patron|moonshine|bottle service)\b(?! ?(glass|glasses|decanter|rack|cabinet|sign|poster|stones?))|\b(wine|beer|seltzer)s? ?(bottles?|cases?|packs?|kegs?)\b|\b\d+ ?ml\b/,
  },
  { id: 'tobacco-vape', label: 'Tobacco, vapes and nicotine', pattern: /\b(vapes?|vaping|e ?cig(arette)?s?|juul|nicotine|cigarettes?|cigars?|tobacco|elf ?bar|geek ?bar|zyn)\b/ },
  { id: 'drugs', label: 'Drugs, cannabis and prescriptions', pattern: /\b(weed|cannabis|marijuana|thc|delta ?[89]|edibles?|shrooms|psilocybin|cocaine|molly|mdma|xanax|adderall|oxy(contin|codone)?|percocet|fentanyl|prescription|kratom)\b/ },
  {
    id: 'weapons', label: 'Weapons, ammunition and explosives',
    pattern: /(?<!(glue|nerf|heat|massage|water|toy|paint|spray|staple|nail|caulk|foam|bubble) )\b(guns?|firearms?|pistols?|handguns?|rifles?|shotguns?|glock)\b|\b(ar ?15|ammo|ammunition|silencer|suppressor|taser|stun gun|brass knuckles|switchblade|explosives?|fireworks?)\b/,
  },
  { id: 'counterfeit', label: 'Counterfeit or replica goods', pattern: /\b(replicas?|counterfeit|knock ?offs?|1 ?: ?1 (copy|quality))\b/ },
  { id: 'financial', label: 'Gift cards, cash, crypto and accounts', pattern: /\b(gift ?cards?|prepaid cards?|bitcoin|usdt|crypto ?(wallet|coins?)|accounts? for sale|followers)\b/ },
  { id: 'ids', label: 'IDs, documents and personal data', pattern: /\b(fake ids?|id cards?|drivers? licen[cs]es?|passports?|social security|ssn|diplomas?)\b/ },
  { id: 'adult', label: 'Adult content and services', pattern: /\b(escort|nudes?|onlyfans|porn|xxx)\b/ },
  { id: 'animals', label: 'Live animals', pattern: /\b(puppy|puppies|kittens?|live animals?)\b/ },
  { id: 'medical', label: 'Injectables and prescription-only drugs', pattern: /\b(syringes?|insulin|ozempic|semaglutide|wegovy|steroids?|sarms)\b/ },
];

export interface SaleListing { title: string; category: SaleCategory; priceCents: number; faceValueCents?: number | null }

export function prohibitedItemFor(title: string): { id: string; label: string } | null {
  // Raw lower-case keeps digits ("750ml", "ar15"); normalized catches
  // de-leeted spellings ("v4pe", "w.e.e.d").
  const texts = [title.toLowerCase(), normalizeForFilter(title)];
  const hit = PROHIBITED_ITEMS.find((item) => texts.some((text) => item.pattern.test(text)));
  return hit ? { id: hit.id, label: hit.label } : null;
}

/** Why a listing is refused, or null. Pure, so the rule is testable without a DB. */
export function saleListingProblem(listing: SaleListing, opts: { newSeller: boolean }): string | null {
  const prohibited = prohibitedItemFor(listing.title);
  if (prohibited) return `${prohibited.label} can't be sold on Bytspot. See the private-sale rules.`;
  const cap = opts.newSeller ? config.privateSaleNewSellerMaxCents : config.privateSaleMaxCents;
  if (listing.priceCents > cap) {
    return opts.newSeller
      ? `New sellers can list items up to $${(cap / 100).toLocaleString('en-US')}. The limit goes up after a few completed sales.`
      : `Private sales are limited to $${(cap / 100).toLocaleString('en-US')}.`;
  }
  if (listing.category === 'event-ticket') {
    // Georgia restricts reselling admission above face value without a
    // broker licence (O.C.G.A. 43-4B-25). Whether and how much markup is
    // lawful is a COUNSEL QUESTION; until answered, Bytspot allows face value
    // or less (TICKET_RESALE_MAX_MARKUP_BPS, default 0).
    if (listing.faceValueCents == null) return 'Enter the face value printed on the ticket.';
    const max = Math.floor(listing.faceValueCents * (10_000 + config.ticketResaleMaxMarkupBps) / 10_000);
    if (listing.priceCents > max) return 'Tickets can be resold for face value or less on Bytspot.';
  }
  return null;
}

/** A seller is new until they have closed this many sales as sold. */
export async function isNewSeller(userId: string): Promise<boolean> {
  const sold = await db.privateSale.count({ where: { sellerId: userId, status: 'sold', moderationHiddenAt: null } });
  return sold < config.privateSaleTrustedAfterSales;
}

export async function assertVerifiedEmailForSales(userId: string): Promise<void> {
  if (!config.privateSalesRequireVerifiedEmail) return;
  const user = await db.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (!user?.emailVerifiedAt) throw new TRPCError({ code: 'FORBIDDEN', message: 'Confirm your email to use private sales.' });
}
