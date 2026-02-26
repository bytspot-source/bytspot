#!/bin/sh
set -e

cd .augment/bytspot-api

# Delete the postgis migration record so it re-applies fresh (needed after plan upgrade)
node -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.\$executeRawUnsafe(
  \"DELETE FROM _prisma_migrations WHERE migration_name = '20260226_add_postgis_pgvector'\"
).then(r => { console.log('Cleaned postgis migration record — will re-apply'); db.\$disconnect(); })
 .catch(e => { console.log('No migration cleanup needed'); db.\$disconnect(); });
" || true

# Run all pending migrations
npx prisma migrate deploy

# Seed database if venues table is empty, or re-populate geo/vector data
node -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  try {
    const c = await db.venue.count();
    if (c === 0) {
      console.log('No venues found — running full seed...');
      require('child_process').execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
    } else {
      console.log('Database has ' + c + ' venues');
      // Try to populate PostGIS geometry if extension is now available
      try {
        await db.\$executeRawUnsafe('UPDATE venues SET location = ST_SetSRID(ST_MakePoint(lng, lat), 4326) WHERE location IS NULL AND lat IS NOT NULL');
        console.log('PostGIS geometry populated');
      } catch(e) { console.log('PostGIS not available yet: ' + e.message.substring(0, 80)); }
      // Try to populate pgvector embeddings if extension is now available
      try {
        const rows = await db.\$queryRawUnsafe('SELECT slug FROM venues WHERE embedding IS NULL');
        if (rows.length > 0) {
          console.log('Populating embeddings for ' + rows.length + ' venues...');
          require('child_process').execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
        }
      } catch(e) { console.log('pgvector not available yet: ' + e.message.substring(0, 80)); }
    }
  } catch(e) { console.error('Seed check failed:', e.message); }
  await db.\$disconnect();
})();
"

# Start the server
node dist/index.js
