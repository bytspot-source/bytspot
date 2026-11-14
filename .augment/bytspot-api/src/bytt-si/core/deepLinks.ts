import { bookingUrlError, type BookingProvider } from '../../services/bookingProviders';
import type { RideLink } from '../types';

/**
 * Hand-off links only. Mirrors bytspot-api mobilityRouter.ts `handoffUrl` and
 * tableBookingLinks.ts host checks. No fares, no availability — ever.
 */
export function rideLinks(destination: { latitude: number; longitude: number; name: string; address: string | null }): RideLink[] {
  const uber = new URL('https://m.uber.com/ul/');
  uber.searchParams.set('action', 'setPickup');
  uber.searchParams.set('pickup', 'my_location');
  uber.searchParams.set('dropoff[latitude]', String(destination.latitude));
  uber.searchParams.set('dropoff[longitude]', String(destination.longitude));
  uber.searchParams.set('dropoff[nickname]', destination.name);
  uber.searchParams.set('dropoff[formatted_address]', destination.address?.trim() || destination.name);
  const lyft = new URL('https://ride.lyft.com/u');
  lyft.searchParams.set('id', 'lyft');
  lyft.searchParams.set('destination[latitude]', String(destination.latitude));
  lyft.searchParams.set('destination[longitude]', String(destination.longitude));
  return [
    { provider: 'uber', url: uber.toString(), fareChecked: false },
    { provider: 'lyft', url: lyft.toString(), fareChecked: false },
  ];
}

/** Same rule as the admin's input: https and the provider's own host. */
export function isValidTableLink(provider: string, url: string): provider is BookingProvider {
  return bookingUrlError(provider, url) === null;
}
