import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { organization, admin } from 'better-auth/plugins';
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { getDb, getMongoClient } from './mongo.js';
import { logger } from './logger.js';

const trustedOrigins = [
  ...env.AUTH_TRUSTED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  env.ADMIN_ORIGIN,
];

const db = await getDb();
const client = await getMongoClient();

function deriveSlug(email: string): string {
  const local = email.split('@')[0] ?? 'org';
  const safe = local.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
  return `${safe}-${randomBytes(4).toString('hex')}`;
}

/** Populated immediately after `betterAuth()` returns; hooks run later so this is always set in time. */
const authHolder: { instance?: unknown } = {};

const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins,
  database: mongodbAdapter(db, { client, transaction: env.MONGO_ADAPTER_USE_TRANSACTIONS }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  advanced: {
    cookiePrefix: 'hallha',
    ...(env.COOKIE_DOMAIN ? { defaultCookieAttributes: { domain: env.COOKIE_DOMAIN } } : {}),
  },
  plugins: [
    admin({
      defaultRole: 'user',
    }),
    organization({
      allowUserToCreateOrganization: true,
      schema: {
        organization: {
          additionalFields: {
            plan: { type: 'string', input: false, defaultValue: 'free' },
            planStatus: { type: 'string', input: false, defaultValue: 'active' },
            currentPeriodStart: { type: 'date', input: false, required: false },
            currentPeriodEnd: { type: 'date', input: false, required: false },
            usageAuditsThisPeriod: { type: 'number', input: false, defaultValue: 0 },
            usageAuditPackCredits: { type: 'number', input: false, defaultValue: 0 },
            stripeCustomerId: { type: 'string', input: false, required: false },
            stripeSubscriptionId: { type: 'string', input: false, required: false },
            legalName: { type: 'string', input: false, required: false },
            registrationNumber: { type: 'string', input: false, required: false },
            country: { type: 'string', input: false, required: false },
            industry: { type: 'string', input: false, required: false },
            bankInstitutionId: { type: 'string', input: false, required: false },
            billingCycle: { type: 'string', input: false, required: false },
            onboardingStep: { type: 'number', input: false, defaultValue: 1 },
            onboardingCompleted: { type: 'boolean', input: false, defaultValue: false },
          },
        },
      },
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await (
              authHolder.instance as { api: { createOrganization: (args: { body: Record<string, unknown> }) => Promise<unknown> } }
            ).api.createOrganization({
              body: {
                name: user.name?.trim() || `${user.email.split('@')[0]}'s workspace`,
                slug: deriveSlug(user.email),
                userId: user.id,
              },
            });
          } catch (err) {
            logger.error({ err, userId: user.id }, 'Failed to auto-create personal organization');
            throw err;
          }
        },
      },
    },
  },
});

authHolder.instance = auth;
export { auth };
