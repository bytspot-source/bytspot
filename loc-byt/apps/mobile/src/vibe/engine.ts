import { api } from '../api';
import { geofenceEnabled } from '../geofence';
import Constants from 'expo-constants';

// Simple heuristic fusion placeholders
async function sampleAudioLoudness(): Promise<number> { return Math.random(); }
async function sampleMotionEnergy(): Promise<number> { return Math.random(); }

function fuse(a:number, m:number) {
  const vibe = Math.max(0, Math.min(10, (a*0.6 + m*0.4)*10));
  const confidence = 0.7 + 0.3 * Math.min(a,m);
  return { vibe, confidence };
}

let timer: any = null;

async function sha256Hex(str: string): Promise<string> {
  const enc = new TextEncoder().encode(str);
  const cryptoAny: any = (globalThis as any).crypto;
  if (!cryptoAny || !cryptoAny.subtle) return '';
  const digest = await cryptoAny.subtle.digest('SHA-256', enc);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map(b => b.toString(16).padStart(2,'0')).join('');
}

async function signIfEnabled(body: string): Promise<Record<string,string>> {
  const secret = (Constants.expoConfig?.extra as any)?.VIBE_HMAC_SECRET;
  if (!secret) return {};
  const sig = await sha256Hex(secret + body);
  return sig ? { 'x-signature': sig } : {};
}

export async function startVibeEngine(venueId: string) {
  if (!geofenceEnabled()) return;
  stopVibeEngine();
  timer = setInterval(async () => {
    try {
      const [a, m] = await Promise.all([sampleAudioLoudness(), sampleMotionEnergy()]);
      const { vibe, confidence } = fuse(a, m);
      const payload = {
        vibeScore: vibe,
        confidence,
        timestamp: new Date().toISOString(),
        features: { audio_loudness_norm: a, motion_energy_norm: m, sample_duration_sec: 5 }
      };
      const body = JSON.stringify(payload);
      const sigHeaders = await signIfEnabled(body);
      const headers = { 'Content-Type': 'application/json', ...sigHeaders };
      await api(`/api/venues/${venueId}/vibe`, { method: 'POST', body, headers });
    } catch (e) {
      // TODO: queue offline failures and retry later
      console.log('vibe submit failed', e);
    }
  }, 120000); // every 2 minutes
}

export function stopVibeEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}

