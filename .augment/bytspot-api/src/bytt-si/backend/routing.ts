import { distanceMeters } from '../../services/checkinProof';
import { handoffUrl } from '../../trpc/mobilityRouter';
import type { RoutingPort } from '../ports/types';

/**
 * RoutingPort: there is no directions provider in bytspot-api yet, so travel is
 * an estimate (1.3× straight line; walk 80 m/min, drive 400 m/min + 10 min
 * pickup), always marked `basis: 'estimate'`. planFeasibility judges travel
 * with its own deliberately generous speed when the plan is saved.
 *
 * Ride links are mobilityRouter.handoffUrl verbatim: Uber/Lyft hand-offs, no fares.
 */
export function createBackendRoutingPort(): RoutingPort {
  return {
    async travel(from, to, mode) {
      const meters = Math.round(distanceMeters({ lat: from.latitude, lng: from.longitude }, { lat: to.latitude, lng: to.longitude }) * 1.3);
      const minutes = mode === 'walk' ? Math.max(1, Math.ceil(meters / 80)) : Math.ceil(meters / 400) + 10;
      return { minutes, meters, basis: 'estimate' };
    },
    rideLinks(destination) {
      const target = { lat: destination.latitude, lng: destination.longitude, name: destination.name, address: destination.address ?? '' };
      return (['uber', 'lyft'] as const).map((provider) => ({ provider, url: handoffUrl(provider, target), fareChecked: false as const }));
    },
  };
}
