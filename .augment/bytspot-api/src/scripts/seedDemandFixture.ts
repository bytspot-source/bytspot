/**
 * A business to answer demand with, so the rail can be run by a person.
 *
 * Everything in the demand path is tested, but no human has published a need
 * and watched a real console answer it. Doing that by hand means creating a
 * seller, a located window and a seat in the right states, which is four
 * chances to create something subtly wrong and then debug the fixture instead
 * of the feature.
 *
 * This writes real rows. Against production it writes them into the database
 * real guests use, so it refuses to run without being told to, names what it is
 * about to touch, and tags everything it creates so `--teardown` can remove
 * exactly that and nothing else.
 *
 * It deliberately cannot create a user. Seats bind to an existing account, so
 * the operator signs up through the app like anyone else and this script is
 * never a way to mint credentials.
 */
process.env.BYTSPOT_RUNTIME = 'job';

// Marks the file a module so its helpers stay local. Without it the script
// shares a global scope with the other job entry points and their `main`
// declarations collide.
export {};

/** Every row this script creates carries it, and teardown removes only these. */
const TAG = 'demandfixture';

interface Options {
  email: string;
  lat: number;
  lng: number;
  timezone: string;
  confirm: boolean;
  teardown: boolean;
}

function parseArgs(argv: string[]): Options | { error: string } {
  const read = (name: string): string | undefined => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const teardown = argv.includes('--teardown');
  const email = read('email') ?? '';
  if (!teardown && !email) return { error: 'Pass --email= of an existing Bytspot account to hold the seat.' };

  const lat = Number(read('lat') ?? '33.7866');
  const lng = Number(read('lng') ?? '-84.3833');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: '--lat and --lng must be numbers.' };
  // The same refusal the publish endpoint makes: a fixture at Null Island
  // matches nothing and looks like a broken feed rather than a bad fixture.
  if (lat === 0 && lng === 0) return { error: 'Refusing to place a business at 0,0.' };

  return {
    email,
    lat,
    lng,
    // Slot derivation produces nothing without one, and a feed with no slots is
    // the hardest symptom to trace back to its cause.
    timezone: read('timezone') ?? 'America/New_York',
    confirm: argv.includes('--confirm'),
    teardown,
  };
}

/** The database being written to, named without exposing its credentials. */
function target(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}${url.pathname}`;
  } catch {
    return 'an unreadable DATABASE_URL';
  }
}

function isLocal(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? '').hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}

async function teardown(): Promise<void> {
  const { db } = await import('../lib/db');

  // Windows and seats first: both point at rows removed below.
  const windows = await db.vendorAvailabilityWindow.deleteMany({ where: { sellerId: { startsWith: TAG } } });
  const seats = await db.vendorSeat.deleteMany({ where: { sellerId: { startsWith: TAG } } });
  const locations = await db.vendorLocation.deleteMany({ where: { sellerId: { startsWith: TAG } } });
  const sellers = await db.vendorSeller.deleteMany({ where: { id: { startsWith: TAG } } });

  console.log(
    `[seed-demand] removed ${sellers.count} seller(s), ${locations.count} location(s), ` +
      `${windows.count} window(s), ${seats.count} seat(s)`,
  );

  // Offers and demand are left alone on purpose. They are what a real person
  // did, and deleting them would erase the evidence the fixture existed to
  // produce. Demand expires on its own.
}

async function seed(options: Options): Promise<void> {
  const { db } = await import('../lib/db');

  const user = await db.user.findFirst({ where: { email: options.email }, select: { id: true } });
  if (!user) throw new Error(`No account for ${options.email}. Sign up in the app first.`);

  const sellerId = `${TAG}-seller`;
  const locationId = `${TAG}-location`;
  const windowId = `${TAG}-window`;

  // ACTIVE because capabilities are derived from seller state: a DRAFT seller's
  // seat cannot SELL, and the console would show the feed but refuse to answer.
  await db.vendorSeller.upsert({
    where: { id: sellerId },
    create: { id: sellerId, legalName: 'Bytspot Demand Fixture', contactEmail: options.email, state: 'ACTIVE' },
    update: { state: 'ACTIVE', contactEmail: options.email },
  });

  await db.vendorLocation.upsert({
    where: { id: locationId },
    create: {
      id: locationId,
      sellerId,
      label: 'Bytspot Demand Fixture',
      kind: 'fixed',
      state: 'ACTIVE',
      lat: options.lat,
      lng: options.lng,
      timezone: options.timezone,
    },
    update: { lat: options.lat, lng: options.lng, timezone: options.timezone, state: 'ACTIVE' },
  });

  // Open every evening so a demand raised at any hour of the working day has
  // something to match, and wide enough that the horizon is never the reason
  // nothing appears.
  await db.vendorAvailabilityWindow.upsert({
    where: { id: windowId },
    create: {
      id: windowId,
      sellerId,
      locationId,
      domain: 'dining',
      skuTemplateId: 'dining.table',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      openMins: 11 * 60,
      closeMins: 23 * 60,
      quantity: 6,
      slotKind: 'rolling',
      slotMinutes: 60,
      leadTimeMins: 30,
      horizonDays: 30,
      priceCents: 5000,
      maxGuests: 8,
      active: true,
    },
    update: { active: true, locationId },
  });

  // Owner, so the seat may SELL once the seller is ACTIVE.
  const existing = await db.vendorSeat.findFirst({ where: { sellerId, userId: user.id }, select: { id: true } });
  if (existing) {
    await db.vendorSeat.update({ where: { id: existing.id }, data: { state: 'ACTIVE', role: 'owner' } });
  } else {
    await db.vendorSeat.create({
      data: { id: `${TAG}-seat`, sellerId, userId: user.id, role: 'owner', state: 'ACTIVE' },
    });
  }

  console.log(`[seed-demand] ready on ${target()}`);
  console.log(`[seed-demand]   seller  ${sellerId} (ACTIVE)`);
  console.log(`[seed-demand]   at      ${options.lat}, ${options.lng} · ${options.timezone}`);
  console.log(`[seed-demand]   window  dining, 11:00\u201323:00 daily, up to 8 guests, $50`);
  console.log(`[seed-demand]   seat    ${options.email} (owner)`);
  console.log('[seed-demand] sign in to the vendor console as that account, then publish a dining need nearby.');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) throw new Error(parsed.error);

  if (!parsed.confirm) {
    console.error(`[seed-demand] this writes real rows to ${target()}.`);
    console.error(
      isLocal()
        ? '[seed-demand] re-run with --confirm.'
        : '[seed-demand] that is NOT a local database. Re-run with --confirm only if you mean it.',
    );
    process.exitCode = 2;
    return;
  }

  if (parsed.teardown) {
    await teardown();
    return;
  }
  await seed(parsed);
}

async function disconnect(): Promise<void> {
  const { db } = await import('../lib/db');
  await db.$disconnect().catch(() => {});
}

main()
  .then(async () => {
    await disconnect();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error('[seed-demand] failed', err instanceof Error ? err.message : err);
    await disconnect();
    process.exit(1);
  });
