import { Entity, PrismaClient, VendorWorkspaceRole } from '@prisma/client';

const db = new PrismaClient();

type SeedVenue = {
  name: string;
  slug: string;
  address: string;
  lat: number;
  lng: number;
  category: string;
  entryType?: 'free' | 'paid';
  entryPrice?: string | null;
  ticketUrl?: string | null;
};

const venues: SeedVenue[] = [
  { name: 'Ponce City Market', slug: 'ponce-city-market', address: '675 Ponce De Leon Ave NE', lat: 33.7726, lng: -84.3655, category: 'market' },
  { name: 'Colony Square', slug: 'colony-square', address: '1197 Peachtree St NE', lat: 33.7878, lng: -84.3832, category: 'market' },
  { name: 'Piedmont Park', slug: 'piedmont-park', address: '400 Park Dr NE', lat: 33.7879, lng: -84.3733, category: 'park' },
  { name: 'Ormsby\'s', slug: 'ormsbys', address: '1170 Howell Mill Rd NW', lat: 33.7815, lng: -84.4072, category: 'bar' },
  { name: 'Livingston', slug: 'livingston', address: '659 Peachtree St NE', lat: 33.7714, lng: -84.3847, category: 'restaurant' },
  { name: 'Lyla Lila', slug: 'lyla-lila', address: '972 Brady Ave NW', lat: 33.7812, lng: -84.4098, category: 'restaurant' },
  { name: 'MBar', slug: 'mbar', address: '1199 Peachtree St NE', lat: 33.7880, lng: -84.3834, category: 'bar' },
  {
    name: 'Tongue & Groove', slug: 'tongue-and-groove', address: '565 Main St NE', lat: 33.7690, lng: -84.3680, category: 'club',
    entryType: 'paid', entryPrice: 'From $20', ticketUrl: 'https://www.tandgonline.com/',
  },
  { name: 'Fado Irish Pub', slug: 'fado-irish-pub', address: '273 Buckhead Ave NE', lat: 33.8395, lng: -84.3680, category: 'bar' },
  { name: 'Krog Street Market', slug: 'krog-street-market', address: '99 Krog St NE', lat: 33.7570, lng: -84.3630, category: 'market' },
  {
    name: 'The Painted Pin', slug: 'the-painted-pin', address: '737 Miami Cir NE', lat: 33.8160, lng: -84.3620, category: 'bar',
    entryType: 'paid', entryPrice: '$20+', ticketUrl: 'https://www.thepaintedpin.com/',
  },
  { name: 'Ladybird Grove & Mess Hall', slug: 'ladybird-grove', address: '684 John Wesley Dobbs Ave NE', lat: 33.7630, lng: -84.3710, category: 'restaurant' },
];

const crowdLabels = ['Chill', 'Active', 'Busy', 'Packed'] as const;

const walkthroughSeed = {
  vendors: [
    { id: 'vendor_maria', ownerId: 'user_vendor_maria', email: 'chef.maria.seed@bytspot.local', displayName: 'Chef Maria’s Table' },
    { id: 'vendor_blackcar', ownerId: 'user_vendor_blackcar', email: 'blackcar.seed@bytspot.local', displayName: 'Atlanta Black Car' },
    { id: 'vendor_zenhaven', ownerId: 'user_vendor_zenhaven', email: 'zenhaven.seed@bytspot.local', displayName: 'Zen Haven Mobile Spa' },
  ],
  users: [
    { id: 'user_sarah', email: 'sarah.seed@bytspot.local', name: 'Sarah Walker' },
    { id: 'user_mike', email: 'mike.seed@bytspot.local', name: 'Mike Reynolds' },
    { id: 'user_lisa', email: 'lisa.seed@bytspot.local', name: 'Lisa Morgan' },
  ],
  services: [
    { id: 'svc_chef_maria', name: '5-Course Italian Dinner Experience', description: 'Private in-home chef dinner with wine pairing', category: 'Catering', price: 285, duration: 150, maxGuests: 8, status: 'ACTIVE', vendorId: 'vendor_maria' },
    { id: 'svc_valet_premium', name: 'Premium Valet Service', description: 'Professional door-to-door valet with Mercedes fleet', category: 'Transportation', price: 95, duration: 45, maxGuests: 4, status: 'ACTIVE', vendorId: 'vendor_blackcar' },
    { id: 'svc_zen_massage', name: 'Deep Tissue Mobile Massage', description: 'Therapist comes to your home or hotel', category: 'Wellness', price: 135, duration: 60, maxGuests: 1, status: 'DRAFT', vendorId: 'vendor_zenhaven' },
  ],
  bookings: [
    { id: 'bk_001', serviceId: 'svc_chef_maria', status: 'CONFIRMED', date: '2026-05-19', time: '19:30', guests: 4, totalAmount: 1140, userId: 'user_sarah' },
    { id: 'bk_002', serviceId: 'svc_valet_premium', status: 'PENDING', date: '2026-05-20', time: '08:00', guests: 2, totalAmount: 190, userId: 'user_mike' },
    { id: 'bk_003', serviceId: 'svc_zen_massage', status: 'CANCELLED', date: '2026-05-18', time: '14:00', guests: 1, totalAmount: 135, userId: 'user_lisa' },
  ],
};

function seedPassword() {
  return 'seeded-disabled-password';
}

function dollarsToCents(value: number) {
  return Math.round(value * 100);
}

function normalizeSeedStatus(value: string) {
  return value.toLowerCase() === 'cancelled' ? 'cancelled' : value.toLowerCase();
}

async function main() {
  console.log('🌱 Seeding Bytspot database...\n');

  for (const v of venues) {
    const venue = await db.venue.upsert({
      where: { slug: v.slug },
      update: {
        name: v.name,
        address: v.address,
        lat: v.lat,
        lng: v.lng,
        category: v.category,
        entryType: v.entryType ?? 'free',
        entryPrice: v.entryPrice ?? null,
        ticketUrl: v.ticketUrl ?? null,
      },
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

    const ticketingLabel = (v.entryType ?? 'free') === 'paid'
      ? `, paid entry ${v.entryPrice ?? ''}${v.ticketUrl ? ' · ticket link set' : ''}`
      : '';
    console.log(`  ✅ ${venue.name} — crowd: ${crowdLabels[level - 1]}, ${numSpots} parking spot(s)${ticketingLabel}`);
  }

  // ─── PostGIS: populate location geometry from lat/lng ──
  console.log('\n📍 Populating PostGIS location geometry...');
  try {
    await db.$executeRawUnsafe(
      `UPDATE "venues" SET "location" = ST_SetSRID(ST_MakePoint("lng", "lat"), 4326) WHERE "location" IS NULL`
    );
    console.log('  ✅ Geometry columns populated from lat/lng');
  } catch (e) {
    console.log('  ⚠️  PostGIS not available — skipping geometry population (run migration first)');
  }

  // ─── pgvector: seed placeholder embeddings ──
  console.log('\n🧠 Seeding placeholder AI embeddings (384-dim)...');
  try {
    // Generate a deterministic pseudo-random embedding per venue (seeded by index)
    for (let i = 0; i < venues.length; i++) {
      const dims = 384;
      const vec = Array.from({ length: dims }, (_, j) => {
        // Simple deterministic pseudo-random based on venue index + dimension
        const seed = (i * 397 + j * 31) % 1000;
        return parseFloat(((seed / 1000) * 2 - 1).toFixed(6));
      });
      const vecStr = `[${vec.join(',')}]`;
      await db.$executeRawUnsafe(
        `UPDATE "venues" SET "embedding" = $1::vector WHERE "slug" = $2`,
        vecStr,
        venues[i].slug,
      );
    }
    console.log(`  ✅ Seeded ${venues.length} placeholder embeddings`);
  } catch (e) {
    console.log('  ⚠️  pgvector not available — skipping embeddings (run migration first)');
  }

  console.log('\n🧑‍🍳 Seeding Provider walkthrough services and bookings...');
  for (const owner of walkthroughSeed.vendors) {
    const ownerUser = await db.user.upsert({
      where: { email: owner.email },
      update: { name: owner.displayName },
      create: { id: owner.ownerId, email: owner.email, password: seedPassword(), name: owner.displayName },
    });
    await db.vendor.upsert({
      where: { id: owner.id },
      update: { userId: ownerUser.id, displayName: owner.displayName, onboardingStatus: 'active', entity: Entity.VENDOR_SERVICES },
      create: { id: owner.id, userId: ownerUser.id, displayName: owner.displayName, onboardingStatus: 'active', entity: Entity.VENDOR_SERVICES },
    });
    await db.vendorMember.upsert({
      where: { vendorId_userId: { vendorId: owner.id, userId: ownerUser.id } },
      update: { role: VendorWorkspaceRole.OWNER },
      create: { vendorId: owner.id, userId: ownerUser.id, role: VendorWorkspaceRole.OWNER },
    });
  }

  for (const user of walkthroughSeed.users) {
    await db.user.upsert({
      where: { email: user.email },
      update: { name: user.name },
      create: { id: user.id, email: user.email, password: seedPassword(), name: user.name },
    });
  }

  for (const service of walkthroughSeed.services) {
    await db.vendorService.upsert({
      where: { id: service.id },
      update: {
        vendorId: service.vendorId,
        title: service.name,
        description: service.description,
        category: service.category,
        priceCents: dollarsToCents(service.price),
        durationMins: service.duration,
        maxGuests: service.maxGuests,
        status: normalizeSeedStatus(service.status),
      },
      create: {
        id: service.id,
        vendorId: service.vendorId,
        title: service.name,
        description: service.description,
        category: service.category,
        priceCents: dollarsToCents(service.price),
        durationMins: service.duration,
        maxGuests: service.maxGuests,
        status: normalizeSeedStatus(service.status),
      },
    });
  }

  for (const booking of walkthroughSeed.bookings) {
    const service = walkthroughSeed.services.find((item) => item.id === booking.serviceId);
    if (!service) continue;
    const priceCents = dollarsToCents(booking.totalAmount);
    await db.booking.upsert({
      where: { id: booking.id },
      update: {
        serviceId: booking.serviceId,
        vendorId: service.vendorId,
        userId: booking.userId,
        status: normalizeSeedStatus(booking.status),
        priceCents,
        platformFeeCents: Math.round(priceCents * 0.08),
        scheduledFor: new Date(`${booking.date}T${booking.time}:00.000Z`),
        metadata: { guests: booking.guests, totalAmount: booking.totalAmount, source: 'provider_walkthrough_seed' },
      },
      create: {
        id: booking.id,
        serviceId: booking.serviceId,
        vendorId: service.vendorId,
        userId: booking.userId,
        entity: Entity.VENDOR_SERVICES,
        status: normalizeSeedStatus(booking.status),
        priceCents,
        platformFeeCents: Math.round(priceCents * 0.08),
        scheduledFor: new Date(`${booking.date}T${booking.time}:00.000Z`),
        metadata: { guests: booking.guests, totalAmount: booking.totalAmount, source: 'provider_walkthrough_seed' },
      },
    });
  }
  console.log(`  ✅ Seeded ${walkthroughSeed.services.length} Provider services and ${walkthroughSeed.bookings.length} bookings.`);

  console.log(`\n🎉 Seeded ${venues.length} venues with crowd levels, parking, geo, and embeddings.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
