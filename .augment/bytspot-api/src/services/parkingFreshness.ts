/**
 * Parking on venue reads, labelled by how current it is.
 *
 * No feed writes parking_spots today, so a venue with no rows is `unknown`.
 * A count is `live` only while every row is newer than PARKING_STALE_AFTER_MS;
 * otherwise it is `stale` and the counts are withheld, so a client that does
 * not read the label still cannot show an old count as current. `typical` is
 * reserved for a day-part estimate; nothing produces one yet.
 */

export type ParkingFreshness = 'live' | 'typical' | 'stale' | 'unknown';

export const PARKING_STALE_AFTER_MS = 15 * 60 * 1000;

export interface ParkingSpotRow {
  name: string;
  type: string;
  available: number;
  totalSpots: number;
  pricePerHr: number | null;
  /** A string after a JSON cache round trip. */
  updatedAt: Date | string;
}

export interface ParkingSpotView {
  name: string;
  type: string;
  available: number | null;
  total: number;
  pricePerHr: number | null;
}

export interface ParkingView {
  freshness: ParkingFreshness;
  /** Oldest row's update time: the age of the least current count. */
  asOf: string | null;
  totalAvailable: number;
  spots: ParkingSpotView[];
}

export function venueParking(rows: ParkingSpotRow[], now: Date = new Date()): ParkingView {
  if (rows.length === 0) return { freshness: 'unknown', asOf: null, totalAvailable: 0, spots: [] };
  const oldest = new Date(Math.min(...rows.map((row) => new Date(row.updatedAt).getTime())));
  const live = Number.isFinite(oldest.getTime()) && now.getTime() - oldest.getTime() <= PARKING_STALE_AFTER_MS;
  return {
    freshness: live ? 'live' : 'stale',
    asOf: Number.isFinite(oldest.getTime()) ? oldest.toISOString() : null,
    totalAvailable: live ? rows.reduce((sum, row) => sum + row.available, 0) : 0,
    spots: rows.map((row) => ({
      name: row.name,
      type: row.type,
      available: live ? row.available : null,
      total: row.totalSpots,
      pricePerHr: row.pricePerHr,
    })),
  };
}
