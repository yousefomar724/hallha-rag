import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';
import { getDb } from '../src/lib/mongo.js';
import { CHAT_THREAD_COLLECTION, namespaceThreadId } from '../src/lib/chat-history.js';
import { env } from '../src/config/env.js';

const invokeMock = vi.fn();
const getStateMock = vi.fn();
const streamEventsMock = vi.fn();

vi.mock('../src/agent/graph.js', () => ({
  getCompiledGraph: vi.fn(async () => ({
    invoke: invokeMock,
    getState: getStateMock,
    streamEvents: streamEventsMock,
  })),
  getEphemeralGraph: vi.fn(() => ({
    invoke: invokeMock,
    getState: getStateMock,
    streamEvents: streamEventsMock,
  })),
}));

const { createApp } = await import('../src/app.js');

describe('DELETE /chats/:thread_id/purge', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    getStateMock.mockReset();
    streamEventsMock.mockReset();
  });

  it('with keepSummary=true stores summary and deletes checkpoints', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new HumanMessage('hello'), new AIMessage('audit result text')],
    });
    getStateMock.mockResolvedValueOnce({
      values: {
        messages: [new HumanMessage('hello'), new AIMessage('audit result text')],
      },
    });

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const db = await getDb();
    const orgId = await getPrimaryOrgIdForUser(userId);

    await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'purge-keep-1')
      .field('message', 'Audit please');

    const res = await request(app)
      .delete('/chats/purge-keep-1/purge')
      .query({ keepSummary: 'true' })
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('purged');
    expect(res.body.summarySaved).toBe(true);
    expect(res.body.threadDeleted).toBe(false);

    const namespaced = namespaceThreadId(orgId, 'purge-keep-1');
    const row = await db.collection(CHAT_THREAD_COLLECTION).findOne({ threadId: namespaced });
    expect(row?.summary).toBe('audit result text');

    const cpCount = await db
      .collection(env.MONGO_CHECKPOINT_COLLECTION)
      .countDocuments({ thread_id: namespaced });
    expect(cpCount).toBe(0);
  });

  it('without keepSummary deletes thread row and checkpoints', async () => {
    invokeMock.mockResolvedValueOnce({ messages: [new AIMessage('x')] });

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const db = await getDb();
    const orgId = await getPrimaryOrgIdForUser(userId);

    await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'purge-full-1')
      .field('message', 'hi');

    const namespaced = namespaceThreadId(orgId, 'purge-full-1');

    const res = await request(app)
      .delete('/chats/purge-full-1/purge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.threadDeleted).toBe(true);
    expect(res.body.summarySaved).toBe(false);

    const row = await db.collection(CHAT_THREAD_COLLECTION).findOne({ threadId: namespaced });
    expect(row).toBeNull();

    const cpCount = await db
      .collection(env.MONGO_CHECKPOINT_COLLECTION)
      .countDocuments({ thread_id: namespaced });
    expect(cpCount).toBe(0);
  });

  it('returns 404 when another user attempts purge', async () => {
    invokeMock.mockResolvedValueOnce({ messages: [new AIMessage('secret')] });

    const app = createApp();
    const userA = await createUserWithSessionCookie(app);
    const userB = await createUserWithSessionCookie(app);

    await request(app)
      .post('/chat-audit')
      .set('Cookie', userA.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'private-purge')
      .field('message', 'mine');

    const res = await request(app)
      .delete('/chats/private-purge/purge')
      .set('Cookie', userB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);

    expect(res.status).toBe(404);
  });
});
