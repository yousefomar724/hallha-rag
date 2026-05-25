/**
 * Seed (or promote) a superadmin user.
 *
 * Usage:
 *   pnpm seed:admin                       # uses SEED_ADMIN_EMAIL from .env
 *   pnpm seed:admin you@example.com       # promote any existing user by email
 *
 * Behaviour:
 *   - If the user already exists, only patches `role: 'superadmin'` and
 *     `emailVerified: true`. No password required.
 *   - If the user does NOT exist, requires SEED_ADMIN_PASSWORD in .env to
 *     create the account via Better-Auth's signUpEmail, then promotes.
 *
 * Idempotent: safe to run multiple times.
 *
 * DNS note: `mongodb+srv://` URIs need DNS SRV record resolution. Some
 * local resolvers (Windows + certain ISPs/firewalls) refuse SRV queries,
 * which surfaces as `querySrv ECONNREFUSED`. To stay robust we point
 * Node's resolver at public DNS (Cloudflare + Google) for this one-off
 * script BEFORE any module that opens a Mongo connection is imported.
 * Override via SEED_DNS_SERVERS="1.1.1.1,8.8.8.8" or disable with
 * SEED_DNS_SERVERS=skip.
 */
import dns from 'node:dns';

const dnsOverride = process.env['SEED_DNS_SERVERS']?.trim();
if (dnsOverride !== 'skip') {
  const servers = dnsOverride && dnsOverride.length > 0
    ? dnsOverride.split(',').map((s) => s.trim()).filter(Boolean)
    : ['1.1.1.1', '8.8.8.8'];
  if (servers.length > 0) {
    try {
      dns.setServers(servers);
    } catch (err) {
      console.warn(`Failed to set custom DNS servers (${servers.join(', ')}):`, err);
    }
  }
}

const { env } = await import('../src/config/env.js');
const { auth } = await import('../src/lib/auth.js');
const { getDb } = await import('../src/lib/mongo.js');

async function main(): Promise<void> {
  const argEmail = process.argv[2]?.trim();
  const envEmail = env.SEED_ADMIN_EMAIL?.trim();
  const email = argEmail && argEmail.length > 0 ? argEmail : envEmail;

  if (!email) {
    console.error(
      'Email is required. Pass it as a CLI argument ' +
        '(`pnpm seed:admin user@example.com`) or set SEED_ADMIN_EMAIL in .env.',
    );
    process.exit(1);
  }

  const db = await getDb();
  const existing = await db.collection('user').findOne({ email });

  if (!existing) {
    const password = env.SEED_ADMIN_PASSWORD;
    if (!password) {
      console.error(
        `User "${email}" does not exist. To create them set SEED_ADMIN_PASSWORD ` +
          'in .env and re-run, or sign them up via the app first and then re-run ' +
          'this script to promote.',
      );
      process.exit(1);
    }
    console.log(`Creating superadmin user: ${email}`);
    await auth.api.signUpEmail({
      body: { email, password, name: 'Super Admin' },
    });
    console.log('User created.');
  } else {
    console.log(`Promoting existing user: ${email}`);
  }

  const result = await db.collection('user').updateOne(
    { email },
    { $set: { role: 'superadmin', emailVerified: true } },
  );
  if (result.matchedCount === 0) {
    console.error(`Failed to locate user "${email}" after create/find step.`);
    process.exit(1);
  }
  console.log(`Role set to superadmin (modified: ${result.modifiedCount}).`);
  console.log('Done. Log out + log back in on the admin SPA to refresh the session role.');
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
