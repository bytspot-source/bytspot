/** Host Studio taxonomy shared by write validation and safe discovery metadata.
 * Mirrors NativeHostType.catalog. A category/type describes an offering; it
 * never grants publication, inventory, admission, or payment authority.
 */
const approvalOnlyDoors = ['private-approval'] as const;
const publicDoors = ['free-rsvp', 'paid-ticket', 'private-approval'] as const;
const hostTypeCatalog: Record<string, { category: string; doors: readonly string[] }> = {
  house: { category: 'party', doors: approvalOnlyDoors },
  'rooftop-party': { category: 'party', doors: approvalOnlyDoors },
  pool: { category: 'party', doors: approvalOnlyDoors },
  birthday: { category: 'party', doors: approvalOnlyDoors },
  afrobeats: { category: 'nightlife', doors: publicDoors },
  club: { category: 'nightlife', doors: publicDoors },
  lounge: { category: 'nightlife', doors: publicDoors },
  'after-hours': { category: 'nightlife', doors: publicDoors },
  listening: { category: 'music', doors: publicDoors },
  release: { category: 'music', doors: publicDoors },
  showcase: { category: 'music', doors: publicDoors },
  'live-set': { category: 'music', doors: publicDoors },
  'watch-party': { category: 'sports', doors: publicDoors },
  tailgate: { category: 'sports', doors: publicDoors },
  'game-night': { category: 'sports', doors: publicDoors },
  dinner: { category: 'food-drink', doors: publicDoors },
  brunch: { category: 'food-drink', doors: publicDoors },
  'pop-up-table': { category: 'food-drink', doors: publicDoors },
  meetup: { category: 'social', doors: publicDoors },
  networking: { category: 'social', doors: publicDoors },
  'fan-meetup': { category: 'social', doors: publicDoors },
  premiere: { category: 'culture', doors: publicDoors },
  comedy: { category: 'culture', doors: publicDoors },
  'art-night': { category: 'culture', doors: publicDoors },
  workshop: { category: 'culture', doors: publicDoors },
  cruise: { category: 'cars', doors: publicDoors },
  'garage-meet': { category: 'cars', doors: approvalOnlyDoors },
  yoga: { category: 'outdoor', doors: publicDoors },
  fitness: { category: 'outdoor', doors: publicDoors },
  hike: { category: 'outdoor', doors: publicDoors },
  market: { category: 'community', doors: publicDoors },
  neighborhood: { category: 'community', doors: publicDoors },
};

export const hostTypeIds = Object.keys(hostTypeCatalog);
export const hostCategoryIds = [...new Set(Object.values(hostTypeCatalog).map((entry) => entry.category))];

export function hostTypeDefinition(type: unknown): { category: string; doors: readonly string[] } | undefined {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(hostTypeCatalog, type)
    ? hostTypeCatalog[type] : undefined;
}

/** Additive classification only, after the caller applies discovery eligibility.
 * Legacy, malformed, and mismatched tags stay absent; no title/category guessing
 * and no disclosure of other arbitrary templateConfig fields.
 */
export function hostDiscoveryTags(config: unknown): { hostCategory?: string; hostType?: string } {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || !Object.prototype.hasOwnProperty.call(config, 'hostType')
    || !Object.prototype.hasOwnProperty.call(config, 'hostCategory')) return {};
  const { hostType, hostCategory } = config as Record<string, unknown>;
  const entry = hostTypeDefinition(hostType);
  if (!entry || typeof hostType !== 'string' || hostCategory !== entry.category) return {};
  return { hostCategory: entry.category, hostType };
}
