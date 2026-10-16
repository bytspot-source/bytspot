/**
 * One-time removal of rows left by older versions of prisma/seed.ts:
 *   - the Colony Square venue, seeded at the retired app fixture's coordinates
 *   - the invented parking lots the seed gave every venue
 *
 * Dry run by default; pass --apply to delete. Parking rows are matched on the
 * exact values the seed wrote. Colony Square is deleted only when nothing but
 * seed rows (crowd levels, parking) points at it; otherwise it is reported and
 * kept, and --hide-linked hides it from guests instead.
 *
 *   node dist/scripts/cleanupSeedFixtures.js            # report only
 *   node dist/scripts/cleanupSeedFixtures.js --apply
 */
export {};

process.env.BYTSPOT_RUNTIME = 'job';

const COLONY_SQUARE = { slug: 'colony-square', name: 'Colony Square', lat: 33.7878, lng: -84.3832 };
const SEED_OWNED_TABLES = new Set(['crowd_levels', 'parking_spots']);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

type Db = import('@prisma/client').PrismaClient;
type Tx = Omit<Db, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export interface CleanupReport {
  seededParkingSpots: number;
  colonySquare: 'absent' | 'deleted' | 'hidden' | 'kept';
  colonySquareLinks: Record<string, number>;
}

const SEEDED_PARKING_WHERE = `
  (p."name" = v."name" || ' Lot' OR p."name" = 'Street — nearby')
  AND p."type" IN ('lot', 'garage')
  AND p."total_spots" IN (40, 80)
  AND p."price_per_hr" IN (0, 6)
  AND p."available" = GREATEST(4, FLOOR(p."total_spots" * 0.4))`;

async function venueLinks(tx: Tx, venueId: string): Promise<Record<string, number>> {
  const columns = await tx.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(`
    SELECT DISTINCT c.relname AS table_name, a.attname AS column_name
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
    WHERE k.contype = 'f' AND k.confrelid = 'public.venues'::regclass
    UNION
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'venue_id' AND table_name <> 'venues'`);
  const links: Record<string, number> = {};
  for (const { table_name: table, column_name: column } of columns) {
    if (!IDENTIFIER.test(table) || !IDENTIFIER.test(column)) throw new Error(`unexpected identifier ${table}.${column}`);
    const [{ n }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}"::text = $1`,
      venueId,
    );
    if (n > 0n) links[`${table}.${column}`] = Number(n);
  }
  return links;
}

export async function cleanupSeedFixtures(db: Db, opts: { apply: boolean; hideLinked: boolean }): Promise<CleanupReport> {
  return db.$transaction(async (tx) => {
    const parking = await tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT p."id" FROM "parking_spots" p JOIN "venues" v ON v."id" = p."venue_id" WHERE ${SEEDED_PARKING_WHERE}`,
    );
    if (opts.apply && parking.length > 0) {
      await tx.parkingSpot.deleteMany({ where: { id: { in: parking.map((p) => p.id) } } });
    }

    const venue = await tx.venue.findFirst({
      where: { slug: COLONY_SQUARE.slug, name: COLONY_SQUARE.name, lat: COLONY_SQUARE.lat, lng: COLONY_SQUARE.lng },
      select: { id: true },
    });
    if (!venue) return { seededParkingSpots: parking.length, colonySquare: 'absent', colonySquareLinks: {} };

    const links = await venueLinks(tx, venue.id);
    const blocking = Object.keys(links).filter((key) => !SEED_OWNED_TABLES.has(key.split('.')[0]));
    const colonySquare: CleanupReport['colonySquare'] = blocking.length === 0 ? 'deleted' : opts.hideLinked ? 'hidden' : 'kept';
    if (opts.apply) {
      if (colonySquare === 'deleted') await tx.venue.delete({ where: { id: venue.id } });
      else if (colonySquare === 'hidden') await tx.venue.update({ where: { id: venue.id }, data: { discoverable: false } });
    }
    return { seededParkingSpots: parking.length, colonySquare, colonySquareLinks: links };
  }, { timeout: 60_000 });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const hideLinked = process.argv.includes('--hide-linked');
  const { db } = await import('../lib/db');
  try {
    const report = await cleanupSeedFixtures(db, { apply, hideLinked });
    const verb = apply ? '' : 'would be ';
    console.log(`[cleanup-seed-fixtures] ${apply ? 'APPLIED' : 'DRY RUN (pass --apply to delete)'}`);
    console.log(`  seeded parking lots ${verb}deleted: ${report.seededParkingSpots}`);
    if (report.colonySquare === 'absent') console.log('  Colony Square fixture: not found');
    else if (report.colonySquare === 'kept') console.log('  Colony Square fixture: KEPT, other records link to it (re-run with --hide-linked to hide it from guests)');
    else console.log(`  Colony Square fixture ${verb}${report.colonySquare}`);
    for (const [link, n] of Object.entries(report.colonySquareLinks)) console.log(`    linked: ${link} = ${n}`);
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

if (process.argv[1]?.match(/cleanupSeedFixtures\.(ts|js)$/)) {
  main().catch((err) => {
    console.error('[cleanup-seed-fixtures] failed', err);
    process.exit(1);
  });
}
