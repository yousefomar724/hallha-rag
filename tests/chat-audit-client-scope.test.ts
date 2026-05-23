import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { AIMessage } from '@langchain/core/messages';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

const { invokeMock, getCompiledGraphMock, getEphemeralGraphMock } = vi.hoisted(() => {
  const invoke = vi.fn();
  return {
    invokeMock: invoke,
    getCompiledGraphMock: vi.fn(async () => ({ invoke })),
    getEphemeralGraphMock: vi.fn(() => ({ invoke })),
  };
});

vi.mock('../src/agent/graph.js', () => ({
  getCompiledGraph: getCompiledGraphMock,
  getEphemeralGraph: getEphemeralGraphMock,
}));

const { createApp } = await import('../src/app.js');

describe('POST /chat-audit with client_id', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    getCompiledGraphMock.mockClear();
    getEphemeralGraphMock.mockClear();
  });

  it('returns 404 when client_id does not belong to the firm', async () => {
    invokeMock.mockResolvedValueOnce({ messages: [new AIMessage('ok')] });

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-unknown-client')
      .field('client_id', '507f1f77bcf86cd799439011')
      .field('message', 'hello');

    expect(res.status).toBe(404);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('threads validated client_id through graph state and namespaces the thread id', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new AIMessage('Client-aware response.')],
      sources: [],
    });

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);

    const created = await request(app)
      .post('/api/clients')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'Bank Beta' });
    expect(created.status).toBe(201);
    const clientId = created.body.client.id as string;

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-client-scope')
      .field('client_id', clientId)
      .field('message', 'audit this');

    expect(res.status).toBe(200);
    expect(res.body.client_id).toBe(clientId);

    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId }),
      expect.objectContaining({
        configurable: { thread_id: `${orgId}:${clientId}:thread-client-scope` },
      }),
    );
  });

  it('rejects cross-firm client_id with 404', async () => {
    invokeMock.mockResolvedValue({ messages: [new AIMessage('ok')] });

    const app = createApp();
    const firmA = await createUserWithSessionCookie(app);
    const firmB = await createUserWithSessionCookie(app);

    const created = await request(app)
      .post('/api/clients')
      .set('Cookie', firmA.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'A Bank' });
    const aClientId = created.body.client.id as string;

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', firmB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-cross-firm')
      .field('client_id', aClientId)
      .field('message', 'hello');

    expect(res.status).toBe(404);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
