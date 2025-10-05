import { Linking, Alert } from 'react-native';
import { api } from './api';
import { track } from './analytics';

export type CheckoutItem = { name: string; amount: number; quantity?: number; currency?: string };

type CheckoutContext = { items: CheckoutItem[]; total: number; hasValet: boolean } | null;
let lastCheckout: CheckoutContext = null;

// Ask Stripe to inject session_id when returning to the app
const SUCCESS_URL = 'matchspot://checkout/success?session_id={CHECKOUT_SESSION_ID}';
const CANCEL_URL = 'matchspot://checkout/cancel';
let deeplinkInited = false;

function parseQuery(url: string): Record<string,string> {
  const q = url.split('?')[1] || '';
  return q.split('&').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    if (k) acc[decodeURIComponent(k)] = decodeURIComponent(v || '');
    return acc;
  }, {} as Record<string,string>);
}

async function enrichFromSession(sessionId?: string) {
  if (!sessionId) return;
  try {
    const d = await api(`/api/payments/session?id=${encodeURIComponent(sessionId)}`);
    // Expect optional fields from backend; best-effort enrichment (no session_id in analytics)
    const { amount_total, currency, payment_method, payment_method_types } = d || {};
    const base = { amount_total, currency, payment_method, payment_method_types };
    track('payment_enriched', base);
    if (lastCheckout?.hasValet) track('valet_payment_enriched', base);
  } catch {}
}

export function initPaymentsDeepLinks() {
  if (deeplinkInited) return;
  deeplinkInited = true;
  Linking.addEventListener('url', ({ url }) => {
    if (url?.startsWith('matchspot://checkout/success')) {
      const params = parseQuery(url);
      const sid = params['session_id'];
      track('payment_success', { total: lastCheckout?.total });
      if (lastCheckout?.hasValet) track('valet_payment_success', { total: lastCheckout?.total });
      enrichFromSession(sid);
    } else if (url?.startsWith('matchspot://checkout/cancel')) {
      track('payment_failure', { reason: 'cancel' });
      if (lastCheckout?.hasValet) track('valet_payment_failed', { reason: 'cancel' });
    }
  });
}

export async function startCheckout(items: CheckoutItem[], successUrl?: string, cancelUrl?: string) {
  try {
    const total = items.reduce((sum, it) => sum + (it.amount || 0) * (it.quantity || 1), 0);
    const hasValet = items.some(it => /valet/i.test(it.name));
    lastCheckout = { items, total, hasValet };

    const res = await api('/api/payments/checkout-session', {
      method: 'POST',
      body: JSON.stringify({ items, successUrl: successUrl || SUCCESS_URL, cancelUrl: cancelUrl || CANCEL_URL })
    });
    const url = res?.url;
    if (url) { track('checkout_opened', { estimated_total: total, has_valet: hasValet, items_count: items.length }); await Linking.openURL(url); }
    else Alert.alert('Checkout', 'No checkout URL returned');
  } catch (e:any) {
    const msg = e?.message || '';
    const reason = /network|timeout/i.test(msg) ? 'network' : 'api_error';
    track('payment_failure', { reason });
    if (lastCheckout?.hasValet) track('valet_payment_failed', { reason });
    Alert.alert('Checkout failed', msg || 'Something went wrong');
  }
}
