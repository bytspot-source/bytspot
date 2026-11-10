/** REA X7: what anyone may learn about Bytspot's size. Rounded down to a step; no beta-lead count. */
export function publicStats(userCount: number, venueCount: number): { userCount: number; venueCount: number } {
  const step = userCount >= 10_000 ? 1000 : userCount >= 1000 ? 100 : 50;
  return { userCount: Math.floor(userCount / step) * step, venueCount };
}
