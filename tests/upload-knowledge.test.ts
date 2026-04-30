import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  setOrganizationPlan,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

vi.mock('../src/rag/ingest.js', async () => {
  const actual = await vi.importActual<typeof import('../src/rag/ingest.js')>('../src/rag/ingest.js');
  return {
    ...actual,
    ingestPdfToPinecone: vi.fn(async () => 'Successfully uploaded 7 document chunks to Pinecone.'),
  };
});

vi.mock('../src/lib/s3.js', () => ({
  putKnowledgeObject: vi.fn(async () => ({
    key: 'knowledge/test/abc-rulebook.pdf',
    url: 'https://example.com/knowledge/test/abc-rulebook.pdf',
  })),
}));

const { createApp } = await import('../src/app.js');
const { ingestPdfToPinecone } = await import('../src/rag/ingest.js');
const { putKnowledgeObject } = await import('../src/lib/s3.js');

describe('POST /upload-knowledge', () => {
  beforeEach(() => {
    vi.mocked(ingestPdfToPinecone).mockClear();
    vi.mocked(putKnowledgeObject).mockClear();
  });

  it('rejects requests without a file with 400', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);
    await setOrganizationPlan(orgId, 'business');

    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/file/i);
  });

  it('rejects free-plan orgs with 402', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'rulebook.pdf');
    expect(res.status).toBe(402);
    expect(res.body.detail).toMatch(/Business/i);
    expect(ingestPdfToPinecone).not.toHaveBeenCalled();
  });

  it('returns success message when ingest succeeds on business plan', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);
    await setOrganizationPlan(orgId, 'business');

    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'rulebook.pdf');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toMatch(/document chunks/);
    expect(res.body.source).toEqual({
      name: 'rulebook.pdf',
      key: 'knowledge/test/abc-rulebook.pdf',
      url: 'https://example.com/knowledge/test/abc-rulebook.pdf',
    });
    expect(putKnowledgeObject).toHaveBeenCalledOnce();
    expect(putKnowledgeObject).toHaveBeenCalledWith(
      expect.any(Buffer),
      'rulebook.pdf',
      expect.any(String),
      orgId,
    );
    expect(ingestPdfToPinecone).toHaveBeenCalledOnce();
    expect(ingestPdfToPinecone).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      originalName: 'rulebook.pdf',
      s3Key: 'knowledge/test/abc-rulebook.pdf',
      s3Url: 'https://example.com/knowledge/test/abc-rulebook.pdf',
      organizationId: orgId,
    });
  });

  it('maps IngestError to HTTP 400', async () => {
    const { IngestError } = await import('../src/rag/ingest.js');
    vi.mocked(ingestPdfToPinecone).mockRejectedValueOnce(
      new IngestError('Could not process the uploaded PDF.'),
    );

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    const orgId = await getPrimaryOrgIdForUser(userId);
    await setOrganizationPlan(orgId, 'business');

    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'bad.pdf');

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/Could not process/);
    expect(putKnowledgeObject).toHaveBeenCalled();
  });
});
