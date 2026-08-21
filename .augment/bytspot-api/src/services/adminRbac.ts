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
  // Format: "<userId>:BYTSPOT_ADMIN,<userId>:INTERNAL_OPS". A bare id defaults
  // to INTERNAL_OPS so the stronger group is never granted implicitly.
  const entries = new Map<string, AdminGroup>();
  for (const part of raw.split(',')) {
    const [idRaw, groupRaw] = part.split(':');
    const userId = idRaw?.trim();
    if (!userId) continue;
    const group = ADMIN_GROUPS.find((g) => g === groupRaw?.trim().toUpperCase()) ?? 'INTERNAL_OPS';
    entries.set(userId, group);
  }
  return entries;
}

/**
 * Admin membership is keyed to the immutable user id, never the email.
 * `auth.signup` is public and performs no email verification, so an
 * email-keyed allowlist would let anyone register an unclaimed admin address
 * and escalate to that group.
 */
export function adminGroupFor(userId: string | undefined, allowlist = config.adminUserIds): AdminGroup | null {
  const normalized = userId?.trim();
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
  const group = adminGroupFor(user.userId);
  if (!group) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin group membership required' });
  }
  return group;
}

/**
 * Boot-time helper: print the immutable user ids behind ADMIN_BOOTSTRAP_EMAILS
 * so an operator can populate ADMIN_USER_IDS from the deploy logs without
 * database shell access.
 *
 * This grants nothing. Email is attacker-choosable because `auth.signup` is
 * public and unverified, so resolution stays a human-reviewed step.
 */
export async function logAdminBootstrapIds(
  findUsers: (emails: string[]) => Promise<Array<{ id: string; email: string }>>,
  raw = config.adminBootstrapEmails,
): Promise<void> {
  const emails = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0) return;

  const users = await findUsers(emails);
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  console.log('   ── Admin bootstrap (resolution only — grants nothing) ──');
  for (const email of emails) {
    const id = byEmail.get(email);
    console.log(id
      ? `   ${email} → ${id}`
      : `   ${email} → NOT REGISTERED — claim this account before granting it`);
  }
  const resolved = emails.map((e) => byEmail.get(e)).filter((id): id is string => Boolean(id));
  if (resolved.length > 0) {
    console.log(`   ADMIN_USER_IDS=${resolved.map((id) => `${id}:BYTSPOT_ADMIN`).join(',')}`);
  }
  console.log('   Set that value, then remove ADMIN_BOOTSTRAP_EMAILS.');
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
