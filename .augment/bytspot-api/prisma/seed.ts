import { PrismaClient } from '@prisma/client';
import {
  MIDTOWN_DAY_PART_VENUES,
  typicalCrowd,
} from '../src/services/typicalOccupancy';

const db = new PrismaClient();

const nightlifeVenues = [
  { name: 'Ponce City Market', slug: 'ponce-city-market', address: '675 Ponce De Leon Ave NE', lat: 33.7726, lng: -84.3655, category: 'market' },
  { name: 'Colony Square', slug: 'colony-square', address: '1197 Peachtree St NE', lat: 33.7878, lng: -84.3832, category: 'market' },
  { name: 'Piedmont Park', slug: 'piedmont-park', address: '400 Park Dr NE', lat: 33.7879, lng: -84.3733, category: 'park' },
  { name: "Ormsby's", slug: 'ormsbys', address: '1170 Howell Mill Rd NW', lat: 33.7815, lng: -84.4072, category: 'bar' },
  { name: 'Livingston', slug: 'livingston', address: '659 Peachtree St NE', lat: 33.7714, lng: -84.3847, category: 'restaurant' },
  { name: 'Lyla Lila', slug: 'lyla-lila', address: '972 Brady Ave NW', lat: 33.7812, lng: -84.4098, category: 'restaurant' },
  { name: 'MBar', slug: 'mbar', address: '1199 Peachtree St NE', lat: 33.7880, lng: -84.3834, category: 'bar' },
  { name: 'Tongue & Groove', slug: 'tongue-and-groove', address: '565 Main St NE', lat: 33.7690, lng: -84.3680, category: 'club' },
  { name: 'Fado Irish Pub', slug: 'fado-irish-pub', address: '273 Buckhead Ave NE', lat: 33.8395, lng: -84.3680, category: 'bar' },
  { name: 'Krog Street Market', slug: 'krog-street-market', address: '99 Krog St NE', lat: 33.7570, lng: -84.3630, category: 'market' },
  { name: 'The Painted Pin', slug: 'the-painted-pin', address: '737 Miami Cir NE', lat: 33.8160, lng: -84.3620, category: 'bar' },
  { name: 'Ladybird Grove & Mess Hall', slug: 'ladybird-grove', address: '684 John Wesley Dobbs Ave NE', lat: 33.7630, lng: -84.3710, category: 'restaurant' },
];

const venues = [
  ...nightlifeVenues,
  ...MIDTOWN_DAY_PART_VENUES.map(({ fingerprint: _fingerprint, ...venue }) => venue),
];

function atlantaClock(now = new Date()): { hour: number; day: number } {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hour: et.getHours(), day: et.getDay() };
}

async function main() {
  console.log('🌱 Seeding Bytspot database (typical occupancy)...\n');
  const { hour, day } = atlantaClock();

  for (const v of venues) {
    const venue = await db.venue.upsert({
      where: { slug: v.slug },
      update: { name: v.name, address: v.address, lat: v.lat, lng: v.lng, category: v.category },
      create: v,
    });

    const crowd = typicalCrowd(hour, day, v.category);
    await db.crowdLevel.create({
      data: {
        venueId: venue.id,
        level: crowd.level,
        label: crowd.label,
        waitMins: crowd.waitMins,
        source: crowd.source,
      },
    });

    const parkingTypes = ['lot', 'garage', 'street'] as const;
    const numSpots = v.category === 'parking' ? 2 : 1;
    for (let i = 0; i < numSpots; i++) {
      const total = v.category === 'golf' || v.category === 'park' ? 80 : 40;
      await db.parkingSpot.create({
        data: {
          venueId: venue.id,
          name: i === 0 ? `${v.name} Lot` : 'Street — nearby',
          type: parkingTypes[i % parkingTypes.length],
          totalSpots: total,
          available: Math.max(4, Math.floor(total * 0.4)),
          pricePerHr: v.category === 'park' ? 0 : 6,
        },
      });
    }

    console.log(`  ✅ ${venue.name} [${v.category}] — typical ${crowd.label} (ET ${hour}:00)`);
  }

  console.log('\n📍 Populating PostGIS location geometry...');
  try {
    await db.$executeRawUnsafe(
      `UPDATE "venues" SET "location" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326) WHERE "location" IS NULL`,
    );
    console.log('  ✅ Geometry columns populated from lat/lng');
  } catch {
    console.log('  ⚠️  PostGIS not available — skipping geometry population (run migration first)');
  }

  console.log('\n🧠 Seeding placeholder AI embeddings (384-dim)...');
  try {
    for (let i = 0; i < venues.length; i++) {
      const dims = 384;
      const vec = Array.from({ length: dims }, (_, j) => {
        const seed = (i * 397 + j * 31) % 1000;
        return parseFloat(((seed / 1000) * 2 - 1).toFixed(6));
      });
      await db.$executeRawUnsafe(
        `UPDATE "venues" SET "embedding" = $1::vector WHERE "slug" = $2`,
        `[${vec.join(',')}]`,
        venues[i].slug,
      );
    }
    console.log(`  ✅ Seeded ${venues.length} placeholder embeddings`);
  } catch {
    console.log('  ⚠️  pgvector not available — skipping embeddings (run migration first)');
  }

  console.log(`\n🎉 Seeded ${venues.length} venues with typical occupancy (not Live).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
