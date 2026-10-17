/** Release A mirror of contracts/discovery-taxonomy.json v1 (consumer rails).
 * Classification never grants supply or any capability beyond details.
 */
export const DISCOVERY_RAILS = [
  'explore', 'eat_drink', 'shop_style', 'experience', 'social', 'events',
  'wellness', 'create_learn', 'nightlife', 'stay', 'move', 'celebrate', 'services',
] as const;
export type DiscoveryRail = typeof DISCOVERY_RAILS[number];

export const DISCOVERY_ALIASES: Readonly<Record<string, DiscoveryRail>> = {
  all: 'explore',
  dining: 'eat_drink', coffee: 'eat_drink', restaurant: 'eat_drink', cafe: 'eat_drink',
  'café': 'eat_drink', 'food-drink': 'eat_drink', catering: 'eat_drink', market: 'eat_drink',
  shopping: 'shop_style', retail: 'shop_style', fashion: 'shop_style', styling: 'shop_style',
  culture: 'experience', outdoor: 'experience', sports: 'experience', museum: 'experience',
  attraction: 'experience', tour: 'experience', park: 'experience',
  community: 'social', meetup: 'social', 'fan-meetup': 'social',
  entertainment: 'events', event: 'events', 'event pass': 'events', music: 'events',
  fitness: 'wellness', spa: 'wellness', gym: 'wellness', recovery: 'wellness',
  class: 'create_learn', workshop: 'create_learn', tutoring: 'create_learn', studio: 'create_learn', education: 'create_learn',
  bar: 'nightlife', club: 'nightlife', night_club: 'nightlife',
  boutique_apartment: 'stay', 'boutique stay': 'stay', hotel: 'stay', lodging: 'stay',
  mobility: 'move', automotive: 'move', transport: 'move', parking: 'move', stall: 'move',
  party: 'celebrate', 'private-party': 'celebrate', celebration: 'celebrate', wedding: 'celebrate', birthday: 'celebrate',
  service: 'services', green: 'services', 'local-service': 'services',
};

/** Google uses a more granular type vocabulary than catalog categories. */
const GOOGLE_CATEGORIES: Readonly<Record<string, string>> = {
  coffee_shop: 'coffee', bakery: 'cafe', tea_house: 'cafe', food: 'restaurant',
  art_gallery: 'culture', tourist_attraction: 'attraction', botanical_garden: 'park',
  national_park: 'park', hiking_area: 'outdoor', zoo: 'attraction', aquarium: 'attraction',
  performing_arts_theater: 'entertainment', movie_theater: 'entertainment',
  concert_hall: 'music', live_music_venue: 'music', event_venue: 'event',
  community_center: 'community', cultural_center: 'culture',
  clothing_store: 'retail', shopping_mall: 'shopping', store: 'retail',
  beauty_salon: 'styling', hair_care: 'styling', hair_salon: 'styling',
  fitness_center: 'fitness', yoga_studio: 'fitness', wellness_center: 'wellness',
  library: 'education', school: 'education', university: 'education',
  pub: 'bar', wine_bar: 'bar', cocktail_bar: 'bar', lounge_bar: 'bar', sports_bar: 'bar',
  motel: 'lodging', bed_and_breakfast: 'lodging', resort_hotel: 'hotel',
  parking_lot: 'parking', transit_station: 'transport', car_rental: 'automotive',
  wedding_venue: 'wedding', banquet_hall: 'celebration',
  laundry: 'service', car_repair: 'service', plumber: 'service', electrician: 'service',
};

export function discoveryRail(category: string | null | undefined): DiscoveryRail {
  const key = (category ?? '').trim().toLowerCase();
  if ((DISCOVERY_RAILS as readonly string[]).includes(key)) return key as DiscoveryRail;
  if (Object.hasOwn(DISCOVERY_ALIASES, key)) return DISCOVERY_ALIASES[key];
  const mapped = Object.hasOwn(GOOGLE_CATEGORIES, key) ? GOOGLE_CATEGORIES[key] : '';
  if (mapped) return discoveryRail(mapped);
  if (key.endsWith('_restaurant')) return 'eat_drink';
  return 'explore';
}
