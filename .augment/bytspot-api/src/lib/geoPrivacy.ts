/**
 * REA review 2026-11-10 (location). A member's precise GPS fix is only ever
 * shown back to that member. Anyone else (other Plan guests, businesses
 * reading demand) gets the point snapped to a ~500 m grid, which is enough to
 * match a venue nearby and not enough to find a front door.
 */
export const COARSE_STEP_DEGREES = 0.005; // ≈ 555 m of latitude

export function coarseCoordinate(value: number, step?: number): number;
export function coarseCoordinate(value: number | null, step?: number): number | null;
export function coarseCoordinate(value: number | null, step = COARSE_STEP_DEGREES): number | null {
  if (value === null || !Number.isFinite(value)) return value;
  // Snap to the centre of the grid cell, and trim float noise.
  const snapped = Math.floor(value / step) * step + step / 2;
  return Math.round(snapped * 1e6) / 1e6;
}

export function coarsePoint<T extends number | null>(latitude: T, longitude: T): { latitude: T; longitude: T } {
  return { latitude: coarseCoordinate(latitude as number | null) as T, longitude: coarseCoordinate(longitude as number | null) as T };
}
