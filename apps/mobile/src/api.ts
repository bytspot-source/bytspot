import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const BFF_URL = (Constants.expoConfig?.extra as any)?.BFF_URL || 'http://localhost:3001';

async function authHeaders() {
  const t = await SecureStore.getItemAsync('access_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function api(path: string, init: RequestInit = {}) {
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init.headers || {}) } as any;
  const res = await fetch(`${BFF_URL}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.status === 204 ? null : res.json();
}

export type Venue = { id: string; title: string; subtitle?: string };

export const venues = {
  discover: async (): Promise<{ items: Venue[] }> => api('/api/venues/discover'),
  like: async (id: string): Promise<void> => api(`/api/venues/${id}/like`, { method: 'POST' }),
  get: async (id: string): Promise<Venue> => api(`/api/venues/${id}`)
};

