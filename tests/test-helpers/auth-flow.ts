import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { getDb } from '../../src/lib/mongo.js';
import { findMemberByUserId, readOrganizationIdFromMember } from '../../src/lib/member-lookup.js';
import {
  findOrganizationDocument,
  organizationUpdateFilter,
} from '../../src/lib/org-billing.js';

export const TEST_AUTH_ORIGIN = 'http://127.0.0.1:3000';

export async function createUserWithSessionCookie(app: Express): Promise<{
  cookieHeader: string;
  userId: string;
}> {
  const email = `t_${randomBytes(8).toString('hex')}@example.com`;
  const res = await request(app)
    .post('/api/auth/sign-up/email')
    .set('Origin', TEST_AUTH_ORIGIN)
    .send({
      email,
      password: 'password12345',
      name: 'Test User',
    });

  if (res.status !== 200) {
    throw new Error(`sign-up failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  const raw = res.headers['set-cookie'];
  if (!raw?.length) {
    throw new Error('sign-up missing Set-Cookie');
  }
  const cookieHeader = raw.map((c) => c.split(';')[0]).join('; ');
  const userId = res.body.user?.id;
  if (typeof userId !== 'string') {
    throw new Error('sign-up response missing user.id');
  }
  return { cookieHeader, userId };
}

export async function getPrimaryOrgIdForUser(userId: string): Promise<string> {
  const db = await getDb();
  const member = await findMemberByUserId(db, userId);
  const orgId = readOrganizationIdFromMember(member);
  if (!orgId) {
    throw new Error(`No organization for user ${userId}`);
  }
  return orgId;
}

export async function setOrganizationPlan(orgId: string, plan: string): Promise<void> {
  const db = await getDb();
  const doc = await findOrganizationDocument(db, orgId);
  if (!doc) {
    throw new Error(`Organization not found for id ${orgId}`);
  }
  await db.collection('organization').updateOne(organizationUpdateFilter(doc), { $set: { plan } });
}

export async function setUserRole(userId: string, role: string): Promise<void> {
  const db = await getDb();
  const { ObjectId } = await import('mongodb');
  const filter = ObjectId.isValid(userId)
    ? { $or: [{ id: userId }, { _id: new ObjectId(userId) }] }
    : { id: userId };
  const result = await db.collection('user').updateOne(filter, { $set: { role } });
  if (result.matchedCount === 0) {
    throw new Error(`User not found for id ${userId}`);
  }
}

export async function setOrganizationAuditUsage(orgId: string, auditsThisPeriod: number): Promise<void> {
  const db = await getDb();
  const doc = await findOrganizationDocument(db, orgId);
  if (!doc) {
    throw new Error(`Organization not found for id ${orgId}`);
  }
  await db.collection('organization').updateOne(organizationUpdateFilter(doc), {
    $set: { usageAuditsThisPeriod: auditsThisPeriod },
  });
}
