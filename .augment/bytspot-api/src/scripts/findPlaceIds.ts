/**
 * Operator tool: look up Google place IDs by name for table-booking-links.json.
 *
 * Read-only. It prints the closest matches near Midtown Atlanta and a draft
 * entry for each; it never edits the list. Pick the right match by address,
 * then fill in `provider`, `url` and `checkedAt` only after opening the
 * booking link yourself.
 *
 *   GOOGLE_PLACES_API_KEY must be set in the environment.
 *   npm run places:find -- "Aria" "Lure"
 *   npm run places:find -- --file names.txt      (one name per line)
 */
import { readFileSync } from 'node:fs';

export {};

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.businessStatus';
/** Midtown Atlanta, biased rather than restricted so a near-edge venue still appears. */
const MIDTOWN = { latitude: 33.7816, longitude: -84.383, radiusMeters: 2500 };
const MATCHES_PER_NAME = 3;

interface Candidate { placeId: string; name: string; address: string; closed: boolean }

function readNames(argv: string[]): string[] {
  const fileAt = argv.indexOf('--file');
  const raw = fileAt >= 0
    ? readFileSync(argv[fileAt + 1] ?? '', 'utf8').split('\n')
    : argv;
  return [...new Set(raw.map((n) => n.trim()).filter((n) => n && !n.startsWith('#')))];
}

async function search(name: string, key: string): Promise<Candidate[]> {
  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify({
      textQuery: `${name}, Midtown Atlanta`,
      maxResultCount: MATCHES_PER_NAME,
      locationBias: {
        circle: { center: { latitude: MIDTOWN.latitude, longitude: MIDTOWN.longitude }, radius: MIDTOWN.radiusMeters },
      },
    }),
  });
  if (!response.ok) throw new Error(`Places search failed with HTTP ${response.status}`);
  const body = await response.json() as {
    places?: { id?: string; displayName?: { text?: string }; formattedAddress?: string; businessStatus?: string }[];
  };
  return (body.places ?? [])
    .filter((p): p is typeof p & { id: string } => typeof p.id === 'string')
    .map((p) => ({
      placeId: p.id,
      name: p.displayName?.text ?? '',
      address: p.formattedAddress ?? '',
      closed: p.businessStatus === 'CLOSED_PERMANENTLY' || p.businessStatus === 'CLOSED_TEMPORARILY',
    }));
}

async function main() {
  const names = readNames(process.argv.slice(2));
  if (names.length === 0) {
    console.error('Usage: npm run places:find -- "<name>" ["<name>" ...]   or   -- --file names.txt');
    process.exit(1);
  }
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) {
    console.error('GOOGLE_PLACES_API_KEY is not set.');
    process.exit(1);
  }

  const drafts: object[] = [];
  let missing = 0;
  for (const name of names) {
    const candidates = await search(name, key);
    console.log(`\n${name}`);
    if (candidates.length === 0) {
      console.log('  no match');
      missing += 1;
      continue;
    }
    candidates.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.name}, ${c.address}${c.closed ? '  [CLOSED]' : ''}\n     ${c.placeId}`);
    });
    const best = candidates.find((c) => !c.closed) ?? candidates[0];
    drafts.push({ placeId: best.placeId, name: best.name, provider: '', url: '', checkedAt: '' });
  }

  console.log('\nDraft entries (first open match each; check the address, then fill provider, url and checkedAt):');
  console.log(JSON.stringify(drafts, null, 2));
  if (missing > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
