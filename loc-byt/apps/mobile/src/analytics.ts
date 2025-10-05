// Analytics wrapper with provider selection
// Supported providers: posthog (default), segment, amplitude

export type EventProps = Record<string, any>;

let provider = (process.env.EXPO_PUBLIC_ANALYTICS_PROVIDER || 'posthog').toLowerCase();
let client: any = null;

// Dev-only drops subscription for UI banner
let _lastDroppedKeys: string[] = [];
const _dropListeners = new Set<(keys: string[]) => void>();
export function onSanitizeDrops(cb: (keys: string[]) => void) { _dropListeners.add(cb); return () => _dropListeners.delete(cb); }
export function getLastSanitizeDrops() { return _lastDroppedKeys.slice(); }

function initAnalytics() {
  try {
    if (provider === 'posthog') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PostHog } = require('posthog-react-native');
      const key = process.env.EXPO_PUBLIC_POSTHOG_KEY;
      const host = process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
      if (key) {
        client = new PostHog(key, { host });
        client.optIn?.();
      }
    } else if (provider === 'segment') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createClient } = require('@segment/analytics-react-native');
      const writeKey = process.env.EXPO_PUBLIC_SEGMENT_WRITE_KEY;
      if (writeKey) client = createClient({ writeKey });
    } else if (provider === 'amplitude') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const amp = require('@amplitude/analytics-react-native');
      const apiKey = process.env.EXPO_PUBLIC_AMPLITUDE_API_KEY;
      if (apiKey) amp.init(apiKey);
      client = { track: (event: string, props: EventProps) => amp.logEvent(event, props) };
    }
  } catch (e) {
    // Provider package likely not installed; fallback to console-only
  }
}

export function sanitizeProps(input: EventProps): EventProps {
  const visited = new WeakSet<object>();
  const quantize = (n: any) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n); // ~1.1km
  const isCoordKey = (k: string) => ['lat','lng','latitude','longitude'].includes(k) || /(_lat|_lng)$/i.test(k);
  const collapseReason = (msg: string) => (/network|timeout/i.test(msg) ? 'network' : 'api_error');
  const droppedKeys: string[] = [];

  const sanitizeAny = (val: any): any => {
    if (val == null) return val;
    if (Array.isArray(val)) return val.map(sanitizeAny);
    if (typeof val === 'object') {
      if (visited.has(val)) return val;
      visited.add(val);
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        if (k === 'session_id' || k === 'sessionId' || k === 'selected' || k === 'email' || k === 'phone') { droppedKeys.push(k); continue; }
        // Collapse error fields to reason first
        if (k === 'error' && typeof v === 'string') { out.reason = collapseReason(v); continue; }
        if (k === 'error_message' && typeof v === 'string') { out.reason = collapseReason(v); continue; }
        // Drop any message-like fields anywhere in key name
        if (/message/i.test(k)) { droppedKeys.push(k); continue; }
        if (isCoordKey(k) && typeof v === 'number') { out[k] = quantize(v); continue; }
        out[k] = sanitizeAny(v);
      }
      return out;
    }
    return val;
  };

  try {
    const sanitized = sanitizeAny({ ...(input || {}) });
    if (droppedKeys.length) {
      const uniq = Array.from(new Set(droppedKeys));
      _lastDroppedKeys = uniq;
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn('[analytics:sanitize] dropped keys:', uniq.join(', '));
        // notify listeners for dev banner
        _dropListeners.forEach((cb) => { try { cb(uniq); } catch {} });
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

initAnalytics();

export function track(event: string, props: EventProps = {}) {
  const safe = sanitizeProps(props);
  try {
    if (provider === 'posthog' && client?.capture) client.capture(event, safe);
    else if (provider === 'segment' && client?.track) client.track(event, safe);
    else if (provider === 'amplitude' && client?.track) client.track(event, safe);
  } catch {}
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[analytics]', event, safe);
  }
}

export function screen(name: string, props: EventProps = {}) {
  const safe = sanitizeProps(props);
  try {
    if (provider === 'posthog' && client?.screen) return client.screen(name, safe);
    if (provider === 'segment' && client?.screen) return client.screen(name, safe);
  } catch {}
  track(`screen:${name}`, safe);
}

