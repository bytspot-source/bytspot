// Two kinds of place. A Bytspot-controlled venue was approved by the Bytspot
// team and shows only Bytspot-curated media and the Bytspot detail display.
// Everything else is listed: Google details and photos, Route, Check in, Plan.
//
// Control is stored as the approval itself and derived here, so a client never
// has to infer it. Anything without an approval reads as `listed`, the closed
// side of the gate.

export type VenueControl = 'bytspot' | 'listed';

export function venueControl(input: { controlledAt?: Date | string | null }): VenueControl {
  const at = input.controlledAt;
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? 'listed' : 'bytspot';
  return typeof at === 'string' && at.trim().length > 0 ? 'bytspot' : 'listed';
}
