/**
 * Operator tool: list accounts whose emails differ only by letter case
 * (`Ama@x.com` and `ama@x.com`). Account emails are still matched exactly at
 * sign-in; this list must be resolved before that matching ignores case.
 * Prints account ids and dates only, never the addresses.
 *
 *   npm run emails:case-collisions
 */
import { db } from '../src/lib/db';

async function main() {
  const groups = await db.$queryRaw<Array<{ ids: string[]; created: Date[] }>>`
    SELECT array_agg("id" ORDER BY "created_at") AS ids, array_agg("created_at" ORDER BY "created_at") AS created
    FROM "users"
    GROUP BY lower("email")
    HAVING count(*) > 1`;

  if (groups.length === 0) {
    console.log('No accounts share an email that differs only by letter case.');
    return;
  }
  console.log(`${groups.length} email(s) are shared by accounts that differ only by letter case:\n`);
  for (const group of groups) {
    console.log('  ' + group.ids.map((id, index) => `${id} (registered ${group.created[index].toISOString().slice(0, 10)})`).join('  ·  '));
  }
  process.exitCode = 1;
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => db.$disconnect());
