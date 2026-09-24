import { z } from 'zod';

export const tipProvider = z.enum(['cash-app', 'paypal-me', 'venmo']);
export type TipProvider = z.infer<typeof tipProvider>;

// Handles only, never URLs, email addresses, phone numbers, amounts or queries.
// Provider rules intentionally differ. Cash App: <=20 with at least one letter;
// PayPal.Me: <=20 ASCII alphanumeric; Venmo: 5–30 incl '-' and '_'.
export function normalizeTipHandle(provider: TipProvider, value: string): string | null {
  let handle = value.trim();
  if (provider === 'cash-app' && handle.startsWith('$')) handle = handle.slice(1);
  if (provider === 'venmo' && handle.startsWith('@')) handle = handle.slice(1);
  const valid = provider === 'cash-app'
    ? /^[A-Za-z0-9]{1,20}$/.test(handle) && /[A-Za-z]/.test(handle)
    : provider === 'paypal-me'
      ? /^[A-Za-z0-9]{1,20}$/.test(handle)
      : /^[A-Za-z0-9_-]{5,30}$/.test(handle);
  return valid ? handle : null;
}

export const tipHandleInput = z.object({ provider: tipProvider, handle: z.string().max(64) }).strict()
  .transform((value, ctx) => {
    const handle = normalizeTipHandle(value.provider, value.handle);
    if (!handle) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid handle for this payment provider, not a URL.' });
      return z.NEVER;
    }
    return { provider: value.provider, handle };
  });
export const tipHandlesInput = z.array(tipHandleInput).max(3).refine(
  (items) => new Set(items.map((item) => item.provider)).size === items.length,
  'Only one handle per provider is allowed.',
);
export type TipHandle = z.infer<typeof tipHandleInput>;

export function canonicalTipURL(tip: TipHandle): string {
  const handle = normalizeTipHandle(tip.provider, tip.handle);
  if (!handle) throw new Error('Invalid payment handle');
  switch (tip.provider) {
    case 'cash-app': return `https://cash.app/$${handle}`;
    case 'paypal-me': return `https://paypal.me/${handle}`;
    case 'venmo': return `https://venmo.com/${handle}`;
  }
}

export function publicTipHandles(value: unknown) {
  const parsed = tipHandlesInput.safeParse(value);
  return parsed.success ? parsed.data.map((tip) => ({ ...tip, url: canonicalTipURL(tip) })) : [];
}

// Mirrors events.invite's non-exported assertShareLinkUsable. Keep this small:
// published status + close/expiry gate, host/confirmed-guest exceptions. A DJ
// invitation is not admission, and does not grant the guest exception.
export function canReadPartyLineup(party: {
  status: string; hostUserId: string; closedAt: Date | null;
  startsAt: Date; endsAt: Date | null; shareLinkExpiresAt: Date | null;
}, viewerId: string | null, accessGranted: boolean, now = Date.now()): boolean {
  if (party.status !== 'published') return false;
  if (viewerId === party.hostUserId || accessGranted) return true;
  const expiry = party.shareLinkExpiresAt ?? party.endsAt ?? new Date(party.startsAt.getTime() + 6 * 60 * 60 * 1000);
  return !party.closedAt && expiry.getTime() > now;
}
