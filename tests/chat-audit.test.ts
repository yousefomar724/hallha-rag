import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { AIMessage } from '@langchain/core/messages';

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
    const res = await request(app).post('/chat-audit').field('message', 'hello');
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/thread_id/);
  });

  it('returns the AI response and echoes thread_id', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new AIMessage('This contract contains Riba.')],
    });

    const app = createApp();
    const res = await request(app)
      .post('/chat-audit')
      .field('thread_id', 'thread-123')
      .field('message', 'Audit this please');

    expect(res.status).toBe(200);
    expect(res.body.thread_id).toBe('thread-123');
    expect(res.body.response).toBe('This contract contains Riba.');
    expect(invokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ documentText: '' }),
      expect.objectContaining({ configurable: { thread_id: 'thread-123' } }),
    );
  });

  it('treats non-PDF uploads as UTF-8 text', async () => {
    invokeMock.mockResolvedValueOnce({ messages: [new AIMessage('ok')] });

    const app = createApp();
    const res = await request(app)
      .post('/chat-audit')
      .field('thread_id', 'thread-utf8')
      .attach('file', Buffer.from('plain text contract', 'utf-8'), 'doc.txt');

    expect(res.status).toBe(200);
    expect(invokeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentText: 'plain text contract' }),
      expect.anything(),
    );
  });

  it('maps LLM quota/rate-limit errors to HTTP 429', async () => {
    invokeMock.mockRejectedValueOnce(new Error('429: rate_limit_exceeded'));

    const app = createApp();
    const res = await request(app)
      .post('/chat-audit')
      .field('thread_id', 'thread-429')
      .field('message', 'hello');

    expect(res.status).toBe(429);
    expect(res.body.detail).toMatch(/quota/i);
  });
});
