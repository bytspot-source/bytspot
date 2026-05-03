import { db } from './db';

const venueCrowdSelect = {
  level: true,
  label: true,
  waitMins: true,
  recordedAt: true,
} as const;

const venueParkingSelect = {
  name: true,
  type: true,
  available: true,
  totalSpots: true,
  pricePerHr: true,
} as const;

export const publicVenueListSelect = {
  id: true,
  name: true,
  slug: true,
  address: true,
  lat: true,
  lng: true,
  category: true,
  imageUrl: true,
  crowdLevels: { orderBy: { recordedAt: 'desc' as const }, take: 1, select: venueCrowdSelect },
  parking: { select: venueParkingSelect },
} as const;

export const publicVenueListSelectWithTicketing = {
  ...publicVenueListSelect,
  entryType: true,
  entryPrice: true,
  ticketUrl: true,
} as const;

export const publicVenueDetailSelect = {
  ...publicVenueListSelect,
  crowdLevels: { orderBy: { recordedAt: 'desc' as const }, take: 24, select: venueCrowdSelect },
} as const;

export const publicVenueDetailSelectWithTicketing = {
  ...publicVenueDetailSelect,
  entryType: true,
  entryPrice: true,
  ticketUrl: true,
} as const;

export const publicVenueCrowdSnapshotSelect = {
  id: true,
  crowdLevels: { orderBy: { recordedAt: 'desc' as const }, take: 1, select: venueCrowdSelect },
} as const;

export const publicVenueCheckinSelect = {
  id: true,
  name: true,
  slug: true,
} as const;

type CrowdRow = {
  level: number;
  label: string;
  waitMins: number | null;
  recordedAt: Date | string;
};

type ParkingRow = {
  name: string;
  type: string;
  available: number;
  totalSpots: number;
  pricePerHr: number | null;
};

type PublicVenueRow = {
  id: string;
  name: string;
  slug: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
  imageUrl: string | null;
  entryType?: string | null;
  entryPrice?: string | null;
  ticketUrl?: string | null;
  crowdLevels: CrowdRow[];
  parking: ParkingRow[];
};

const formatRecordedAt = (recordedAt: Date | string) =>
  recordedAt instanceof Date ? recordedAt.toISOString() : String(recordedAt);

const mapParking = (parking: ParkingRow[]) => ({
  totalAvailable: parking.reduce((sum, spot) => sum + spot.available, 0),
  spots: parking.map((spot) => ({
    name: spot.name,
    type: spot.type,
    available: spot.available,
    total: spot.totalSpots,
    pricePerHr: spot.pricePerHr,
  })),
});

export async function hasVenueTicketingColumns(): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'venues'
        AND column_name IN ('entry_type', 'entry_price', 'ticket_url')`
  );

  const columnNames = new Set(rows.map((row) => row.column_name));
  return ['entry_type', 'entry_price', 'ticket_url'].every((columnName) => columnNames.has(columnName));
}

export function mapPublicVenueSummary(venue: PublicVenueRow) {
  return {
    id: venue.id,
    name: venue.name,
    slug: venue.slug,
    address: venue.address,
    lat: venue.lat,
    lng: venue.lng,
    category: venue.category,
    imageUrl: venue.imageUrl,
    entryType: venue.entryType === 'paid' ? 'paid' : 'free',
    entryPrice: venue.entryPrice ?? null,
    ticketUrl: venue.ticketUrl ?? null,
    crowd: venue.crowdLevels[0]
      ? {
          level: venue.crowdLevels[0].level,
          label: venue.crowdLevels[0].label,
          waitMins: venue.crowdLevels[0].waitMins,
          recordedAt: formatRecordedAt(venue.crowdLevels[0].recordedAt),
        }
      : null,
    parking: mapParking(venue.parking),
  };
}

export function mapPublicVenueDetail(venue: PublicVenueRow) {
  return {
    id: venue.id,
    name: venue.name,
    slug: venue.slug,
    address: venue.address,
    lat: venue.lat,
    lng: venue.lng,
    category: venue.category,
    imageUrl: venue.imageUrl,
    entryType: venue.entryType === 'paid' ? 'paid' : 'free',
    entryPrice: venue.entryPrice ?? null,
    ticketUrl: venue.ticketUrl ?? null,
    crowd: {
      current: venue.crowdLevels[0]
        ? {
            ...venue.crowdLevels[0],
            recordedAt: formatRecordedAt(venue.crowdLevels[0].recordedAt),
          }
        : null,
      history: venue.crowdLevels.map((crowd) => ({
        ...crowd,
        recordedAt: formatRecordedAt(crowd.recordedAt),
      })),
    },
    parking: venue.parking.map((spot) => ({
      name: spot.name,
      type: spot.type,
      available: spot.available,
      total: spot.totalSpots,
      pricePerHr: spot.pricePerHr,
    })),
  };
}

export function mapPublicVenueCrowdSnapshot(venue: Pick<PublicVenueRow, 'id' | 'crowdLevels'>) {
  return {
    id: venue.id,
    crowd: venue.crowdLevels[0]
      ? {
          level: venue.crowdLevels[0].level,
          label: venue.crowdLevels[0].label,
          waitMins: venue.crowdLevels[0].waitMins,
          recordedAt: formatRecordedAt(venue.crowdLevels[0].recordedAt),
        }
      : null,
  };
}