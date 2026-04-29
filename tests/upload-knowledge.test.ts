import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('../src/rag/ingest.js', async () => {
  const actual = await vi.importActual<typeof import('../src/rag/ingest.js')>('../src/rag/ingest.js');
  return {
    ...actual,
    ingestPdfToPinecone: vi.fn(async () => 'Successfully uploaded 7 document chunks to Pinecone.'),
  };
});

const { createApp } = await import('../src/app.js');
const { ingestPdfToPinecone } = await import('../src/rag/ingest.js');

describe('POST /upload-knowledge', () => {
  beforeEach(() => {
    vi.mocked(ingestPdfToPinecone).mockClear();
  });

  it('rejects requests without a file with 400', async () => {
    const app = createApp();
    const res = await request(app).post('/upload-knowledge');
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/file/i);
  });

  it('returns success message when ingest succeeds', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/upload-knowledge')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'rulebook.pdf');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toMatch(/document chunks/);
    expect(ingestPdfToPinecone).toHaveBeenCalledOnce();
  });

  it('maps IngestError to HTTP 400', async () => {
    const { IngestError } = await import('../src/rag/ingest.js');
    vi.mocked(ingestPdfToPinecone).mockRejectedValueOnce(new IngestError('Uploaded file is empty.'));

    const app = createApp();
    const res = await request(app)
      .post('/upload-knowledge')
      .attach('file', Buffer.from(''), 'empty.pdf');

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/empty/);
  });
});
