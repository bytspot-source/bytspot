import { TRPCError } from '@trpc/server';
import { config } from '../config';
import type { AuthPayload } from '../middleware/auth';

/**
 * Admin groups recognised by the API. Mirrors the group names used by the
 * provider-approval RBAC review so a single vocabulary covers every admin
 * surface.
 */
export const ADMIN_GROUPS = ['BYTSPOT_ADMIN', 'INTERNAL_OPS'] as const;

export type AdminGroup = (typeof ADMIN_GROUPS)[number];

function parseAllowlist(raw: string): Map<string, AdminGroup> {
  // Format: "ops@bytspot.com:BYTSPOT_ADMIN,oncall@bytspot.com:INTERNAL_OPS".
  // A bare email defaults to INTERNAL_OPS so the stronger group is never
  // granted implicitly.
  const entries = new Map<string, AdminGroup>();
  for (const part of raw.split(',')) {
    const [emailRaw, groupRaw] = part.split(':');
    const email = emailRaw?.trim().toLowerCase();
    if (!email) continue;
    const group = ADMIN_GROUPS.find((g) => g === groupRaw?.trim().toUpperCase()) ?? 'INTERNAL_OPS';
    entries.set(email, group);
  }
  return entries;
}

export function adminGroupFor(email: string | undefined, allowlist = config.adminEmails): AdminGroup | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  return parseAllowlist(allowlist).get(normalized) ?? null;
}

/**
 * Fail-closed admin gate for authenticated procedures.
 *
 * Unauthenticated callers get UNAUTHORIZED; authenticated non-admins get
 * FORBIDDEN, so an admin surface never reports whether a given action exists
 * to an ordinary signed-in user.
 */
export function assertBytspotAdmin(user: AuthPayload | null | undefined): AdminGroup {
  if (!user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  const group = adminGroupFor(user.email);
  if (!group) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin group membership required' });
  }
  return group;
}

/**
 * Structured audit line for an admin action. Admin identity must be
 * attributable, so every gated call records who acted and under which group.
 */
export function auditAdminAction(entry: {
  actorId: string;
  actorEmail: string;
  group: AdminGroup;
  action: string;
  detail?: Record<string, string | number | boolean>;
}): void {
  console.log(JSON.stringify({
    type: 'admin.audit',
    at: new Date().toISOString(),
    actorId: entry.actorId,
    actorEmail: entry.actorEmail,
    group: entry.group,
    action: entry.action,
    ...entry.detail,
  }));
}
