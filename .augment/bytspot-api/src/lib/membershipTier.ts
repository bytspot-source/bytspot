export const membershipTierRank = { green: 0, platinum: 1, black: 2 } as const;
export type MembershipTier = keyof typeof membershipTierRank;

export function isMembershipTier(value: unknown): value is MembershipTier {
  return typeof value === 'string' && value in membershipTierRank;
}

export function meetsRequiredMembershipTier(membershipTier: unknown, requiredMembershipTier: unknown): boolean {
  return isMembershipTier(membershipTier)
    && isMembershipTier(requiredMembershipTier)
    && membershipTierRank[membershipTier] >= membershipTierRank[requiredMembershipTier];
}