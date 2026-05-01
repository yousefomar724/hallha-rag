/**
 * Seed a superadmin user.
 *
 * Usage:
 *   pnpm seed:admin
 *
 * Required env vars (in .env):
 *   SEED_ADMIN_EMAIL    e.g. admin@hallha.com
 *   SEED_ADMIN_PASSWORD e.g. StrongPass123
 *
 * Idempotent: safe to run multiple times. If the user already exists,
 * only the role and emailVerified fields are updated.
 */
import { env } from '../src/config/env.js';
import { auth } from '../src/lib/auth.js';
import { getDb } from '../src/lib/mongo.js';

async function main(): Promise<void> {
  const email = env.SEED_ADMIN_EMAIL;
  const password = env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in .env');
    process.exit(1);
  }

  const db = await getDb();
  const existing = await db.collection('user').findOne({ email });

  if (!existing) {
    console.log(`Creating superadmin user: ${email}`);
    await auth.api.signUpEmail({
      body: { email, password, name: 'Super Admin' },
    });
    console.log('User created.');
  } else {
    console.log(`User already exists: ${email}`);
  }

  const result = await db.collection('user').updateOne(
    { email },
    { $set: { role: 'superadmin', emailVerified: true } },
  );
  console.log(`Role set to superadmin (modified: ${result.modifiedCount}).`);
  console.log('Done.');
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
