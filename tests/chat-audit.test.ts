import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { AIMessage } from '@langchain/core/messages';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

const invokeMock = vi.fn();

vi.mock('../src/agent/graph.js', () => ({
  getCompiledGraph: vi.fn(async () => ({
    invoke: invokeMock,
  })),
}));

const { createApp } = await import('../src/app.js');

describe('POST /chat-audit', () => {
  it('rejects missing thread_id with 422', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('message', 'hello');
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/thread_id/);
  });

  it('returns the AI response and echoes thread_id', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new AIMessage('This contract contains Riba.')],
    });

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-123')
      .field('message', 'Audit this please');

    expect(res.status).toBe(200);
    expect(res.body.thread_id).toBe('thread-123');
    expect(res.body.response).toBe('This contract contains Riba.');
    expect(res.body.sources).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ documentText: '' }),
      expect.objectContaining({
        configurable: { thread_id: `${orgId}:thread-123` },
      }),
    );
  });

  it('returns structured sources alongside the response', async () => {
    const mockSources = [
      {
        id: 1,
        type: 'document' as const,
        source: 'aaoifi.pdf',
        displayName: 'AAOIFI Standards',
        page: 12,
        url: 'https://cdn/example/aaoifi.pdf',
      },
      {
        id: 2,
        type: 'document' as const,
        source: 'shariah_resolutions.pdf',
        displayName: 'Shariah resolutions',
        page: 4,
      },
    ];
    invokeMock.mockResolvedValueOnce({
      messages: [new AIMessage('Riba is present in clause 3 [1].')],
      sources: mockSources,
    });

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-cite')
      .field('message', 'audit this');

    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual(mockSources);
  });

  it('treats non-PDF uploads as UTF-8 text', async () => {
    invokeMock.mockResolvedValueOnce({ messages: [new AIMessage('ok')] });

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-utf8')
      .attach('file', Buffer.from('plain text contract', 'utf-8'), 'doc.txt');

    expect(res.status).toBe(200);
    expect(invokeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentText: 'plain text contract' }),
      expect.objectContaining({ configurable: { thread_id: `${orgId}:thread-utf8` } }),
    );
  });

  it('maps LLM quota/rate-limit errors to HTTP 429', async () => {
    invokeMock.mockRejectedValueOnce(new Error('429: rate_limit_exceeded'));

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'thread-429')
      .field('message', 'hello');

    expect(res.status).toBe(429);
    expect(res.body.detail).toMatch(/quota/i);
  });
});
