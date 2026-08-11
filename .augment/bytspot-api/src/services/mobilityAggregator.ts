import { config } from '../config';

export type MobilityAggregatorReadiness = 'handoff' | 'not-configured' | 'ready-for-contract-validation';

/**
 * Deliberately keeps the upstream API behind one boundary. Until the aggregator
 * supplies its approved request/response schema, the application stays in
 * handoff mode and must not send rider or location data to an unknown endpoint.
 */
export function mobilityAggregatorReadiness(): MobilityAggregatorReadiness {
  if (config.mobilityAggregatorMode !== 'live') return 'handoff';
  if (!config.mobilityAggregatorBaseUrl || !config.mobilityAggregatorApiKey) return 'not-configured';
  return 'ready-for-contract-validation';
}

export function aggregatorConfigurationIsComplete(): boolean {
  return mobilityAggregatorReadiness() === 'ready-for-contract-validation';
}