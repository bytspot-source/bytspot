#!/usr/bin/env bash
set -euo pipefail

BFF_URL=${BFF_URL:-http://localhost:3000}
AUTH_URL=${AUTH_URL:-http://localhost:8090}
EMAIL=${EMAIL:-admin-test@bytspot.ai}
PASSWORD=${PASSWORD:-S3cret!Pass}

# 1) Register user
curl -s -f -X POST "$AUTH_URL/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null || true

echo "Registered (or exists): $EMAIL"

# 2) Login
LOGIN_JSON=$(curl -s -f -X POST "$AUTH_URL/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$LOGIN_JSON" | awk -F '"' '/access_token/ {print $4}')
if [ -z "$TOKEN" ]; then echo "Login failed"; exit 1; fi

echo "Got token"

# 3) Promote admin (dev endpoint)
curl -s -f -X POST "$AUTH_URL/dev/promote-admin" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\"}" >/dev/null || true

echo "Promoted to admin via dev endpoint"

# 4) Access BFF admin route
curl -s -f "$BFF_URL/api/admin/venues" -H "Authorization: Bearer $TOKEN" >/dev/null

echo "BFF admin route accessible"

