import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { ObjectId } from 'mongodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  createUserWithSessionCookie,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';
import { getDb } from '../src/lib/mongo.js';
import { cleanupOrphanCheckpoints } from '../src/lib/chat-history.js';
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
}));

const { createApp } = await import('../src/app.js');

describe('Chat history endpoints', () => {
  it('GET /chats returns an empty list for a fresh user', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .get('/chats')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.threads)).toBe(true);
    expect(res.body.threads.length).toBe(0);
  });

  it('records a thread on /chat-audit and lists/gets/deletes it', async () => {
    invokeMock.mockResolvedValueOnce({
      messages: [new HumanMessage('Audit this'), new AIMessage('Looks compliant.')],
    });

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    // 1. Hit /chat-audit to create a thread
    const auditRes = await request(app)
      .post('/chat-audit')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'history-1')
      .field('message', 'Audit this please');
    expect(auditRes.status).toBe(200);

    // 2. List should include it with derived title
    const listRes = await request(app)
      .get('/chats')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(listRes.status).toBe(200);
    expect(listRes.body.threads).toHaveLength(1);
    expect(listRes.body.threads[0].thread_id).toBe('history-1');
    expect(listRes.body.threads[0].title).toBe('Audit this please');

    // 3. GET /chats/:id replays messages from the (mocked) checkpointer
    getStateMock.mockResolvedValueOnce({
      values: {
        messages: [new HumanMessage('Audit this please'), new AIMessage('Looks compliant.')],
      },
    });
    const detailRes = await request(app)
      .get('/chats/history-1')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.thread_id).toBe('history-1');
    expect(detailRes.body.messages).toEqual([
      { role: 'user', content: 'Audit this please' },
      { role: 'assistant', content: 'Looks compliant.' },
    ]);
    expect(detailRes.body.sources).toEqual([]);

    // 4. DELETE removes it
    const delRes = await request(app)
      .delete('/chats/history-1')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(delRes.status).toBe(200);
    expect(delRes.body.status).toBe('deleted');

    const listAfter = await request(app)
      .get('/chats')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(listAfter.body.threads).toHaveLength(0);
  });

  it('does not leak threads across users', async () => {
    invokeMock.mockResolvedValueOnce({ messages: [new AIMessage('ok')] });

    const app = createApp();
    const userA = await createUserWithSessionCookie(app);
    const userB = await createUserWithSessionCookie(app);

    await request(app)
      .post('/chat-audit')
      .set('Cookie', userA.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'private-thread')
      .field('message', 'sensitive contract');

    const userBList = await request(app)
      .get('/chats')
      .set('Cookie', userB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(userBList.body.threads).toHaveLength(0);

    const userBDirect = await request(app)
      .get('/chats/private-thread')
      .set('Cookie', userB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(userBDirect.status).toBe(404);
  });

  it('streams audit tokens via SSE on /chat-audit/stream', async () => {
    streamEventsMock.mockImplementation(() =>
      (async function* () {
        yield { event: 'on_chat_model_stream', data: { chunk: { content: 'Hello ' } } };
        yield { event: 'on_chat_model_stream', data: { chunk: { content: 'world' } } };
      })(),
    );

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit/stream')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('thread_id', 'sse-1')
      .field('message', 'Audit me');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: meta');
    expect(res.text).toContain('"thread_id":"sse-1"');
    expect(res.text).toContain('event: token');
    expect(res.text).toContain('"text":"Hello "');
    expect(res.text).toContain('"text":"world"');
    expect(res.text).toContain('event: sources');
    expect(res.text).toContain('event: done');
  });

  it('rejects /chats without a session', async () => {
    const app = createApp();
    const res = await request(app).get('/chats');
    expect(res.status).toBe(401);
  });

  it('cleanupOrphanCheckpoints removes old checkpoint docs without a chat_thread row', async () => {
    const db = await getDb();
    const orphanThreadId = `orphan-${new ObjectId().toHexString()}`;
    const oldId = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 7200); // 2h ago

    await db.collection(env.MONGO_CHECKPOINT_COLLECTION).insertOne({
      _id: oldId,
      thread_id: orphanThreadId,
      checkpoint: {},
    });
    await db.collection(env.MONGO_CHECKPOINT_WRITES_COLLECTION).insertOne({
      _id: ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 7200),
      thread_id: orphanThreadId,
      task_id: 't',
    });

    const result = await cleanupOrphanCheckpoints();
    expect(result.orphaned).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .collection(env.MONGO_CHECKPOINT_COLLECTION)
      .countDocuments({ thread_id: orphanThreadId });
    expect(remaining).toBe(0);
    const remainingWrites = await db
      .collection(env.MONGO_CHECKPOINT_WRITES_COLLECTION)
      .countDocuments({ thread_id: orphanThreadId });
    expect(remainingWrites).toBe(0);
  });
});
