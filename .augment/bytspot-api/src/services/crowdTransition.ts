/** True only for a real transition into the Packed alert threshold. */
export function entersPacked(previousLevel: number | null | undefined, nextLevel: number): boolean {
  return (previousLevel ?? 0) < 4 && nextLevel >= 4;
}
