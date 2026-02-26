import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const venues = [
  { name: 'Ponce City Market', slug: 'ponce-city-market', address: '675 Ponce De Leon Ave NE', lat: 33.7726, lng: -84.3655, category: 'market' },
  { name: 'Colony Square', slug: 'colony-square', address: '1197 Peachtree St NE', lat: 33.7878, lng: -84.3832, category: 'market' },
  { name: 'Piedmont Park', slug: 'piedmont-park', address: '400 Park Dr NE', lat: 33.7879, lng: -84.3733, category: 'park' },
  { name: 'Ormsby\'s', slug: 'ormsbys', address: '1170 Howell Mill Rd NW', lat: 33.7815, lng: -84.4072, category: 'bar' },
  { name: 'Livingston', slug: 'livingston', address: '659 Peachtree St NE', lat: 33.7714, lng: -84.3847, category: 'restaurant' },
  { name: 'Lyla Lila', slug: 'lyla-lila', address: '972 Brady Ave NW', lat: 33.7812, lng: -84.4098, category: 'restaurant' },
  { name: 'MBar', slug: 'mbar', address: '1199 Peachtree St NE', lat: 33.7880, lng: -84.3834, category: 'bar' },
  { name: 'Tongue & Groove', slug: 'tongue-and-groove', address: '565 Main St NE', lat: 33.7690, lng: -84.3680, category: 'club' },
  { name: 'Fado Irish Pub', slug: 'fado-irish-pub', address: '273 Buckhead Ave NE', lat: 33.8395, lng: -84.3680, category: 'bar' },
  { name: 'Krog Street Market', slug: 'krog-street-market', address: '99 Krog St NE', lat: 33.7570, lng: -84.3630, category: 'market' },
  { name: 'The Painted Pin', slug: 'the-painted-pin', address: '737 Miami Cir NE', lat: 33.8160, lng: -84.3620, category: 'bar' },
  { name: 'Ladybird Grove & Mess Hall', slug: 'ladybird-grove', address: '684 John Wesley Dobbs Ave NE', lat: 33.7630, lng: -84.3710, category: 'restaurant' },
];

const crowdLabels = ['Chill', 'Active', 'Busy', 'Packed'] as const;

async function main() {
  console.log('🌱 Seeding Bytspot database...\n');

  for (const v of venues) {
    const venue = await db.venue.upsert({
      where: { slug: v.slug },
      update: { name: v.name, address: v.address, lat: v.lat, lng: v.lng, category: v.category },
      create: v,
    });

    // Seed a current crowd level (random for demo)
    const level = Math.floor(Math.random() * 4) + 1;
    await db.crowdLevel.create({
      data: {
        venueId: venue.id,
        level,
        label: crowdLabels[level - 1],
        waitMins: level >= 3 ? Math.floor(Math.random() * 30) + 5 : null,
        source: 'manual',
      },
    });

    // Seed 1-2 parking spots per venue
    const parkingTypes = ['lot', 'garage', 'street'] as const;
    const numSpots = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < numSpots; i++) {
      const total = Math.floor(Math.random() * 80) + 20;
      await db.parkingSpot.create({
        data: {
          venueId: venue.id,
          name: i === 0 ? `${v.name} Lot` : `Street — nearby`,
          type: parkingTypes[Math.floor(Math.random() * parkingTypes.length)],
          totalSpots: total,
          available: Math.floor(Math.random() * total),
          pricePerHr: parseFloat((Math.random() * 8 + 2).toFixed(2)),
        },
      });
    }

    console.log(`  ✅ ${venue.name} — crowd: ${crowdLabels[level - 1]}, ${numSpots} parking spot(s)`);
  }

  console.log(`\n🎉 Seeded ${venues.length} venues with crowd levels and parking data.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
