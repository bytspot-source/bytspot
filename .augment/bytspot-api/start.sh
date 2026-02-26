#!/bin/sh
set -e

cd .augment/bytspot-api

# Resolve any previously failed migrations so deploy can retry
npx prisma migrate resolve --rolled-back 20260226_add_postgis_pgvector 2>/dev/null || true

# Run migrations (init will succeed, postgis will succeed defensively)
npx prisma migrate deploy

# Start the server
node dist/index.js
