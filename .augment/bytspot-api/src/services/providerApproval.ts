import { TRPCError } from '@trpc/server';
import { type Prisma } from '@prisma/client';
import { db } from '../lib/db';
import { type AuthPayload } from '../middleware/auth';

const ADMIN_APPROVAL_GROUPS = ['BYTSPOT_ADMIN', 'INTERNAL_OPS'] as const;

type ApproveProviderApplicationInput = {
  userId?: string;
  email?: string;
  approvedBy: string;
  activateVendor?: boolean;
  markStripeConnectReady?: boolean;
};

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

export function assertProviderApprovalAdmin(user: AuthPayload): void {
  const groups = new Set((user.groups ?? []).map((group) => group.trim().toUpperCase()).filter(Boolean));
  if (!ADMIN_APPROVAL_GROUPS.some((group) => groups.has(group))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Provider approvals require BYTSPOT_ADMIN or INTERNAL_OPS group membership.' });
  }
}

export async function listPendingProviderApplications(limit = 50) {
  const rows = await db.hostProfile.findMany({
    where: { status: 'pending' },
    orderBy: [{ submittedAt: 'asc' }, { updatedAt: 'asc' }],
    take: Math.max(1, Math.min(limit, 100)),
    select: {
      id: true,
      userId: true,
      status: true,
      currentStep: true,
      onboardingData: true,
      submittedAt: true,
      approvedAt: true,
      updatedAt: true,
      user: {
        select: {
          email: true,
          name: true,
          vendors: {
            orderBy: { updatedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              displayName: true,
              legalName: true,
              onboardingStatus: true,
              stripeAccountId: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  return {
    applications: rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      status: row.status,
      currentStep: row.currentStep,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      user: { email: row.user.email, name: row.user.name },
      vendor: row.user.vendors[0] ? {
        ...row.user.vendors[0],
        updatedAt: row.user.vendors[0].updatedAt.toISOString(),
      } : null,
    })),
  };
}

export async function approveProviderApplication(input: ApproveProviderApplicationInput) {
  if (!input.userId && !input.email) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Provide userId or email to approve a provider application.' });
  }

  const user = input.userId
    ? await db.user.findUnique({ where: { id: input.userId } })
    : await db.user.findUnique({ where: { email: input.email! } });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Provider user not found.' });

  const [hostProfile, vendor] = await Promise.all([
    db.hostProfile.findUnique({ where: { userId: user.id } }),
    db.vendor.findFirst({ where: { userId: user.id }, orderBy: { updatedAt: 'desc' } }),
  ]);
  if (!hostProfile) throw new TRPCError({ code: 'NOT_FOUND', message: 'No provider HostProfile found for this user.' });

  const approvedAt = new Date();
  const approvedAtIso = approvedAt.toISOString();
  const activateVendor = input.activateVendor ?? true;

  const result = await db.$transaction(async (tx) => {
    const approvedProfile = await tx.hostProfile.update({
      where: { userId: user.id },
      data: { status: 'approved', approvedAt, submittedAt: hostProfile.submittedAt ?? approvedAt },
    });

    const approvedVendor = vendor ? await tx.vendor.update({
      where: { id: vendor.id },
      data: {
        onboardingStatus: activateVendor ? 'active' : vendor.onboardingStatus,
        metadata: {
          ...jsonObject(vendor.metadata),
          ...(input.markStripeConnectReady ? {
            stripeConnect: {
              ...jsonObject(jsonObject(vendor.metadata).stripeConnect as Prisma.JsonValue | null),
              accountId: vendor.stripeAccountId ?? null,
              chargesEnabled: true,
              payoutsEnabled: true,
              detailsSubmitted: true,
              disabledReason: null,
              currentlyDue: [],
              pastDue: [],
              syncedAt: approvedAtIso,
            },
          } : {}),
          providerApproval: {
            status: 'approved',
            approvedAt: approvedAtIso,
            approvedBy: input.approvedBy,
            source: 'admin.approveProviderApplication',
          },
        } as Prisma.InputJsonValue,
      },
    }) : null;

    return { approvedProfile, approvedVendor };
  });

  return {
    host: {
      id: result.approvedProfile.id,
      userId: result.approvedProfile.userId,
      status: result.approvedProfile.status,
      approvedAt: result.approvedProfile.approvedAt?.toISOString() ?? null,
      submittedAt: result.approvedProfile.submittedAt?.toISOString() ?? null,
    },
    vendor: result.approvedVendor ? {
      id: result.approvedVendor.id,
      userId: result.approvedVendor.userId,
      onboardingStatus: result.approvedVendor.onboardingStatus,
      metadata: result.approvedVendor.metadata,
    } : null,
    sideEffects: {
      vendorActivated: Boolean(result.approvedVendor && activateVendor),
      stripeConnectMarkedReady: Boolean(result.approvedVendor && input.markStripeConnectReady),
      sovereignShieldStateFlags: ['PROVIDER_ADMIN_APPROVAL'],
    },
  };
}