import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  setUserRole,
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

vi.mock('../src/lib/knowledge-files.js', () => ({
  recordKnowledgeFile: vi.fn(async () => {}),
  ensureKnowledgeFileIndexes: vi.fn(async () => {}),
  getKnowledgeFileMetaForKeys: vi.fn(async () => new Map()),
  deleteKnowledgeFileByS3Key: vi.fn(async () => {}),
  upsertKnowledgeFileBackfill: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { ingestPdfToPinecone } = await import('../src/rag/ingest.js');
const { putKnowledgeObject } = await import('../src/lib/s3.js');
const { recordKnowledgeFile } = await import('../src/lib/knowledge-files.js');

describe('POST /upload-knowledge', () => {
  beforeEach(() => {
    vi.mocked(ingestPdfToPinecone).mockClear();
    vi.mocked(putKnowledgeObject).mockClear();
    vi.mocked(recordKnowledgeFile).mockClear();
  });

  it('rejects non-admin users with 403', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'rulebook.pdf');
    expect(res.status).toBe(403);
    expect(ingestPdfToPinecone).not.toHaveBeenCalled();
  });

  it('rejects admin requests without a file with 400', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    await setUserRole(userId, 'admin');

    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/file/i);
  });

  it('returns success message when admin uploads a file', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    await setUserRole(userId, 'admin');
    const orgId = await getPrimaryOrgIdForUser(userId);

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
      displayName: 'rulebook.pdf',
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
    expect(recordKnowledgeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        s3Key: 'knowledge/test/abc-rulebook.pdf',
        organizationId: orgId,
        originalName: 'rulebook.pdf',
        displayName: 'rulebook.pdf',
        uploadedBy: userId,
      }),
    );
  });

  it('accepts optional displayName and stores it on the knowledge_files doc', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    await setUserRole(userId, 'admin');
    const orgId = await getPrimaryOrgIdForUser(userId);

    const res = await request(app)
      .post('/upload-knowledge')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('displayName', 'AAOIFI Standards (EN)')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'rulebook.pdf');

    expect(res.status).toBe(200);
    expect(res.body.source.displayName).toBe('AAOIFI Standards (EN)');
    expect(recordKnowledgeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        originalName: 'rulebook.pdf',
        displayName: 'AAOIFI Standards (EN)',
      }),
    );
  });

  it('maps IngestError to HTTP 400 for admin', async () => {
    const { IngestError } = await import('../src/rag/ingest.js');
    vi.mocked(ingestPdfToPinecone).mockRejectedValueOnce(
      new IngestError('Could not process the uploaded PDF.'),
    );

    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    await setUserRole(userId, 'admin');

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
