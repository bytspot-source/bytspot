/**
 * Operator tool: turn admin email addresses into the immutable user ids that
 * ADMIN_USER_IDS expects.
 *
 * Requires database access, so it is an operator action rather than an auth
 * path — the allowlist itself never resolves emails, because `auth.signup` is
 * public and unverified.
 *
 *   npm run admin:resolve -- ops@bytspot.com kojo@bytspot.com
 */
import { db } from '../src/lib/db';

async function main() {
  const emails = process.argv.slice(2).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0) {
    console.error('Usage: npm run admin:resolve -- <email> [email...]');
    process.exit(1);
  }

  const users = await db.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, createdAt: true },
  });

  const found = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  for (const email of emails) {
    const user = found.get(email);
    if (user) {
      console.log(`  ${email} -> ${user.id}  (registered ${user.createdAt.toISOString().slice(0, 10)})`);
    } else {
      // An unregistered admin address is a squatting target: signup is public,
      // so anyone could claim it. Register it before granting the group.
      console.log(`  ${email} -> NOT REGISTERED — do not grant; claim the account first`);
    }
  }

  const resolved = emails.map((e) => found.get(e)).filter((u): u is NonNullable<typeof u> => Boolean(u));
  if (resolved.length > 0) {
    console.log('\nADMIN_USER_IDS=' + resolved.map((u) => `${u.id}:BYTSPOT_ADMIN`).join(','));
  }
  if (resolved.length !== emails.length) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => db.$disconnect());
