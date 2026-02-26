#!/bin/sh
set -e

cd .augment/bytspot-api

# If the postgis migration was previously rolled back, delete its record so it re-applies
node -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.\$executeRawUnsafe(
  \"DELETE FROM _prisma_migrations WHERE migration_name = '20260226_add_postgis_pgvector' AND rolled_back_at IS NOT NULL\"
).then(r => { console.log('Cleaned rolled-back migration record'); db.\$disconnect(); })
 .catch(e => { console.log('No migration cleanup needed'); db.\$disconnect(); });
" || true

# Run all pending migrations
npx prisma migrate deploy

# Seed database if venues table is empty (first deploy only)
node -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
db.venue.count().then(async c => {
  if (c === 0) {
    console.log('No venues found — running seed...');
    require('child_process').execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
  } else {
    console.log('Database already seeded (' + c + ' venues)');
  }
  await db.\$disconnect();
}).catch(async e => { console.error('Seed check failed:', e.message); await db.\$disconnect(); });
"

# Start the server
node dist/index.js
