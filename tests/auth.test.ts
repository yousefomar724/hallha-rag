import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { AIMessage } from '@langchain/core/messages';
import { getDb } from '../src/lib/mongo.js';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  setOrganizationAuditUsage,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';
import { findOrganizationDocument } from '../src/lib/org-billing.js';

const invokeMock = vi.fn();

vi.mock('../src/agent/graph.js', () => ({
  getCompiledGraph: vi.fn(async () => ({
    invoke: invokeMock,
  })),
}));

const { createApp } = await import('../src/app.js');

describe('Authentication & billing scaffolding', () => {
  it('sign-up creates a user and personal organization in Mongo', async () => {
    const app = createApp();
    const { userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);
    const db = await getDb();
    const org = await findOrganizationDocument(db, orgId);
    expect(org).toBeTruthy();
    expect(org?.plan ?? 'free').toBe('free');
  });

  it('returns 401 from /chat-audit without a session cookie', async () => {
    const app = createApp();
    const res = await request(app).post('/chat-audit').field('thread_id', 'x').field('message', 'hi');
    expect(res.status).toBe(401);
  });

  it('accepts /chat-audit with a valid session and increments audit usage', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new AIMessage('ok')],
    });
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);
    await setOrganizationAuditUsage(orgId, 0);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'audit-1')
      .field('message', 'hello');

    expect(res.status).toBe(200);

    const db = await getDb();
    const org = await findOrganizationDocument(db, orgId);
    expect(Number(org?.usageAuditsThisPeriod ?? 0)).toBe(1);
  });

  it('returns 402 when free-plan audit quota is exhausted', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new AIMessage('ok')],
    });
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);
    await setOrganizationAuditUsage(orgId, 5);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'audit-cap')
      .field('message', 'hello');

    expect(res.status).toBe(402);
    expect(res.body.detail).toMatch(/limit/i);

    const db = await getDb();
    const org = await findOrganizationDocument(db, orgId);
    expect(Number(org?.usageAuditsThisPeriod ?? 0)).toBe(5);
  });
});
