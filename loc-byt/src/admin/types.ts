export type Session = { sub: string; roles: string[] };
export type VenueItem = { id: string; title: string; subtitle?: string; rating?: number; distance?: string; price?: string };
export type UserItem = { id: string; email: string; name?: string };
export type AuditItem = { id: string; actor_id: string; target_email: string; action: 'promote'|'demote'; reason?: string; created_at: string };
export type HostType = { key: 'venue'|'parking'|'valet'; label: string; description: string };
export type HostOnboardingState = { userId?: string; serviceType?: HostType['key']; data?: Record<string, any>; progress: number };

