import type { TableBookingLink } from '../../services/tableBookingLinks';
import type { BookablesPort } from '../ports/types';

/**
 * BookablesPort for Google places: the hand-checked OpenTable/Resy link from
 * tableBookingLinks.ts (refreshed first, like plans.get does). A link is a
 * hand-off, never availability.
 *
 * Bytspot supply is not keyed by Google place: `Bookable` rows are snapshots
 * made when supply is attached to a Plan, parties arrive through EventsPort
 * (selection `party:<id>`), and CoffeeSpot has no place id. So places carry no
 * Bytspot bookables here rather than a guessed match.
 */
export interface BookablesAdapterDeps {
  ensure(): Promise<void>;
  linkFor(placeId: string): TableBookingLink | null;
}

export function createBackendBookablesPort(deps: BookablesAdapterDeps): BookablesPort {
  return {
    async forPlace(placeId) {
      await deps.ensure();
      const link = deps.linkFor(placeId);
      return { bookables: [], tableLink: link ? { provider: link.provider, label: link.label, url: link.url } : null };
    },
  };
}
