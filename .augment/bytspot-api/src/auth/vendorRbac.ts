import jwt from 'jsonwebtoken';
import { TRPCError } from '@trpc/server';
import { config } from '../config';
import { db } from '../lib/db';

export type ProviderRole = 'owner' | 'manager' | 'staff';

export type VendorRoleClaim = {
  vendorId: string;
  role: ProviderRole;
  groups: string[];
};

export type AuthClaims = {
  userId: string;
  email: string;
  groups: string[];
  vendorRoles: VendorRoleClaim[];
};

const ROLE_RANK: Record<ProviderRole, number> = { staff: 1, manager: 2, owner: 3 };

export function normalizeProviderRole(role: unknown): ProviderRole {
  const value = String(role ?? '').trim().toLowerCase();
  if (value === 'owner') return 'owner';
  if (value === 'manager') return 'manager';
  return 'staff';
}

export function vendorGroups(vendorId: string, role: ProviderRole): string[] {
  const base = [`bytspot:vendor:${vendorId}:member`, `bytspot:vendor:${vendorId}:${role}`];
  if (role === 'owner') {
    return [...base, `bytspot:vendor:${vendorId}:admin`, `bytspot:vendor:${vendorId}:finance`, `bytspot:vendor:${vendorId}:stripe-connect`, `bytspot:vendor:${vendorId}:catalog-write`, `bytspot:vendor:${vendorId}:patch-write`];
  }
  if (role === 'manager') {
    return [...base, `bytspot:vendor:${vendorId}:operations`, `bytspot:vendor:${vendorId}:catalog-write`, `bytspot:vendor:${vendorId}:patch-write`];
  }
  return [...base, `bytspot:vendor:${vendorId}:operations-read`];
}

function bestRole(current: ProviderRole | undefined, next: ProviderRole): ProviderRole {
  if (!current) return next;
  return ROLE_RANK[next] > ROLE_RANK[current] ? next : current;
}

export async function buildVendorRoleClaims(userId: string): Promise<VendorRoleClaim[]> {
  const rolesByVendor = new Map<string, ProviderRole>();

  const vendorMember = (db as any).vendorMember;
  if (vendorMember?.findMany) {
    const memberships = await vendorMember.findMany({ where: { userId }, select: { vendorId: true, role: true } });
    for (const membership of memberships ?? []) {
      const role = normalizeProviderRole(membership.role);
      rolesByVendor.set(membership.vendorId, bestRole(rolesByVendor.get(membership.vendorId), role));
    }
  }

  let ownedVendors: Array<{ id: string }> = [];
  try {
    ownedVendors = await ((db.vendor as any).findMany?.({ where: { userId }, select: { id: true } }) ?? Promise.resolve([]));
  } catch {
    ownedVendors = [];
  }
  for (const vendor of ownedVendors) {
    rolesByVendor.set(vendor.id, 'owner');
  }

  return Array.from(rolesByVendor.entries()).map(([vendorId, role]) => ({ vendorId, role, groups: vendorGroups(vendorId, role) }));
}

export async function buildAuthClaims(userId: string, email: string): Promise<AuthClaims> {
  const vendorRoles = await buildVendorRoleClaims(userId);
  const groups = Array.from(new Set(['bytspot:user', ...vendorRoles.flatMap((claim) => claim.groups)]));
  return { userId, email, groups, vendorRoles };
}

export async function signAuthToken(userId: string, email: string): Promise<string> {
  const claims = await buildAuthClaims(userId, email);
  return jwt.sign(claims, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as string & jwt.SignOptions['expiresIn'],
  });
}

export function claimRoleForVendor(claims: { vendorRoles?: VendorRoleClaim[] } | null | undefined, vendorId: string): ProviderRole | null {
  const claim = claims?.vendorRoles?.find((item) => item.vendorId === vendorId);
  return claim ? normalizeProviderRole(claim.role) : null;
}

export function assertVendorRole(role: ProviderRole, allowed: readonly ProviderRole[], operation: string): void {
  if (!allowed.includes(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `${operation} requires ${allowed.join('/')} vendor role` });
  }
}
