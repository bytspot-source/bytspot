import type { Session, AuditItem, HostOnboardingState, HostType, VenueItem, UserItem } from './types';

const API_BASE = (import.meta as any).env.VITE_BFF_URL || 'http://localhost:3000';

export function getAuthHeaders(): Record<string, string> {
  const t = localStorage.getItem('access_token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export async function fetchSession(): Promise<Session | null> {
  const r = await fetch(`${API_BASE}/api/auth/session`, { headers: getAuthHeaders() });
  if (!r.ok) return null;
  return r.json();
}

export async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API_BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error('Login failed');
  const d = await r.json();
  if (!d.access_token) throw new Error('No access token');
  localStorage.setItem('access_token', d.access_token);
  return d.access_token as string;
}

export async function fetchAudit(limit = 50): Promise<{ items: AuditItem[] }> {
  const r = await fetch(`${API_BASE}/api/auth/admin/audit?limit=${limit}`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error('Failed to fetch audit');
  return r.json();
}

export async function fetchHostTypes(): Promise<{ progress: number; types: HostType[] }> {
  const r = await fetch(`${API_BASE}/api/host/onboarding/types`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error('Failed to fetch host types');
  return r.json();
}

export async function getHostOnboarding(): Promise<HostOnboardingState | null> {
  const r = await fetch(`${API_BASE}/api/host/onboarding`, { headers: getAuthHeaders() });
  if (!r.ok) return null;
  return r.json();
}

export async function upsertHostOnboarding(patch: Partial<HostOnboardingState>) {
  const r = await fetch(`${API_BASE}/api/host/onboarding`, { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  if (!r.ok) throw new Error('Failed to save onboarding');
}

export async function fetchVenues(): Promise<{ items: VenueItem[] }> {
  const r = await fetch(`${API_BASE}/api/admin/venues`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error('Failed to fetch venues');
  return r.json();
}

export async function createVenue(input: { title: string; subtitle?: string; rating?: number; distance?: string; price?: string }): Promise<VenueItem> {
  const r = await fetch(`${API_BASE}/api/admin/venues`, { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error('Failed to create venue');
  return r.json();
}

export async function fetchUsers(): Promise<{ items: UserItem[] }> {
  const r = await fetch(`${API_BASE}/api/admin/users`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error('Failed to fetch users');
  return r.json();
}

export async function fetchAnalyticsSummary(): Promise<{ users: number; venues: number; likes: number }> {
  const r = await fetch(`${API_BASE}/api/admin/analytics/summary`, { headers: getAuthHeaders() });
  if (!r.ok) throw new Error('Failed to fetch analytics');
  return r.json();
}

