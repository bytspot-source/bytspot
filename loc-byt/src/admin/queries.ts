import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSession, fetchAudit, fetchHostTypes, getHostOnboarding, upsertHostOnboarding, fetchVenues, createVenue, fetchUsers, fetchAnalyticsSummary } from './api';

export function useSessionQuery(enabled: boolean) {
  return useQuery({ queryKey: ['session'], queryFn: fetchSession, enabled, staleTime: 60_000, retry: 1 });
}

export function useAuditQuery(enabled: boolean) {
  return useQuery({ queryKey: ['audit', { limit: 50 }], queryFn: () => fetchAudit(50), enabled, staleTime: 30_000, retry: 1 });
}

export function useHostTypesQuery() {
  return useQuery({ queryKey: ['hostTypes'], queryFn: fetchHostTypes, staleTime: 5 * 60_000, retry: 1 });
}

export function useOnboardingQuery(enabled: boolean) {
  return useQuery({ queryKey: ['onboarding'], queryFn: getHostOnboarding, enabled, staleTime: 10_000, retry: 1 });
}

export function useUpsertOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: upsertHostOnboarding,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['onboarding'] }); },
    retry: 0,
  });
}

export function useVenuesQuery(enabled: boolean) {
  return useQuery({ queryKey: ['adminVenues'], queryFn: fetchVenues, enabled, staleTime: 10_000, retry: 1 });
}
export function useCreateVenue() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: createVenue, onSuccess: () => qc.invalidateQueries({ queryKey: ['adminVenues'] }), retry: 0 });
}

export function useUsersQuery(enabled: boolean) {
  return useQuery({ queryKey: ['adminUsers'], queryFn: fetchUsers, enabled, staleTime: 10_000, retry: 1 });
}
export function useAnalyticsQuery(enabled: boolean) {
  return useQuery({ queryKey: ['adminAnalytics'], queryFn: fetchAnalyticsSummary, enabled, staleTime: 10_000, retry: 1 });
}

