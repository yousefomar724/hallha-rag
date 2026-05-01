import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createUserWithSessionCookie,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

vi.mock('../src/lib/groq-transcription.js', () => ({
  transcribeAudioBuffer: vi.fn(),
}));

const { createApp } = await import('../src/app.js');
const { transcribeAudioBuffer } = await import('../src/lib/groq-transcription.js');

const transcribeMock = vi.mocked(transcribeAudioBuffer);

describe('POST /chat-audit/transcribe', () => {
  beforeEach(() => {
    transcribeMock.mockReset();
  });

  it('rejects missing audio with 422', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit/transcribe')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);

    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/audio/i);
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it('returns trimmed transcription text', async () => {
    transcribeMock.mockResolvedValueOnce('  hello world  ');

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit/transcribe')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('audio', Buffer.from('fake-bytes'), 'clip.webm');

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('hello world');
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(transcribeMock.mock.calls[0]?.[1]).toBe('clip.webm');
  });

  it('rejects empty transcription with 422', async () => {
    transcribeMock.mockResolvedValueOnce('   \n');

    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/chat-audit/transcribe')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('audio', Buffer.from('x'), 'x.webm');

    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/speech/i);
  });

  it('requires authentication', async () => {
    const app = createApp();

    const res = await request(app)
      .post('/chat-audit/transcribe')
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('audio', Buffer.from('x'), 'x.webm');

    expect(res.status).toBe(401);
    expect(transcribeMock).not.toHaveBeenCalled();
  });
});
