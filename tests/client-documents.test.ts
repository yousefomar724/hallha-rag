import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createUserWithSessionCookie,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

vi.mock('../src/rag/ingest.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/rag/ingest.js')>('../src/rag/ingest.js');
  return {
    ...actual,
    ingestPdfToPinecone: vi.fn(async () => 'Successfully uploaded 3 document chunks to Pinecone.'),
  };
});

vi.mock('../src/rag/delete-knowledge.js', () => ({
  deleteKnowledgeVectorsByS3Key: vi.fn(async () => {}),
}));

const s3KeyHolder: { key: string } = { key: '' };
vi.mock('../src/lib/s3.js', () => ({
  putClientObject: vi.fn(async (_buf, name, _ct, firmId, clientId, docType) => {
    const key = `uploads/firms/${firmId}/clients/${clientId}/${docType}/uuid-${name}`;
    s3KeyHolder.key = key;
    return { key, url: `https://example.com/${key}` };
  }),
  deleteClientObject: vi.fn(async () => {}),
  // Provide stubs for other s3 functions imported elsewhere
  putGlobalAaoifiObject: vi.fn(async () => ({ key: '', url: '' })),
  listKnowledgeObjects: vi.fn(async () => ({ items: [], nextContinuationToken: null })),
  listGlobalAaoifiObjects: vi.fn(async () => ({ items: [], nextContinuationToken: null })),
  deleteKnowledgeObject: vi.fn(async () => {}),
  displayNameFromObjectKey: (k: string) => k,
  GLOBAL_AAOIFI_S3_PREFIX: 'uploads/global/aaoifi/',
}));

const { createApp } = await import('../src/app.js');
const { ingestPdfToPinecone } = await import('../src/rag/ingest.js');
const { putClientObject, deleteClientObject } = await import('../src/lib/s3.js');
const { deleteKnowledgeVectorsByS3Key } = await import('../src/rag/delete-knowledge.js');
const { clientTenantNamespace } = await import('../src/lib/pinecone.js');

async function createClientForTest(
  app: ReturnType<typeof createApp>,
  cookie: string,
): Promise<string> {
  const res = await request(app)
    .post('/api/clients')
    .set('Cookie', cookie)
    .set('Origin', TEST_AUTH_ORIGIN)
    .send({ name: 'Test Bank' });
  if (res.status !== 201) {
    throw new Error(`create client failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.client.id as string;
}

describe('Client document upload + delete', () => {
  beforeEach(() => {
    vi.mocked(ingestPdfToPinecone).mockClear();
    vi.mocked(putClientObject).mockClear();
    vi.mocked(deleteClientObject).mockClear();
    vi.mocked(deleteKnowledgeVectorsByS3Key).mockClear();
  });

  it('uploads to the firm/client/documentType S3 prefix and per-client namespace', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const clientId = await createClientForTest(app, cookieHeader);

    const res = await request(app)
      .post(`/api/clients/${clientId}/documents`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('documentType', 'contracts')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'master-agreement.pdf');

    expect(res.status).toBe(201);
    expect(res.body.document.documentType).toBe('contracts');
    expect(res.body.document.s3Key).toMatch(
      new RegExp(
        `^uploads/firms/[^/]+/clients/${clientId}/contracts/uuid-master-agreement\\.pdf$`,
      ),
    );

    expect(putClientObject).toHaveBeenCalledOnce();
    expect(putClientObject).toHaveBeenCalledWith(
      expect.any(Buffer),
      'master-agreement.pdf',
      expect.any(String),
      expect.any(String),
      clientId,
      'contracts',
    );

    expect(ingestPdfToPinecone).toHaveBeenCalledOnce();
    const ingestArgs = vi.mocked(ingestPdfToPinecone).mock.calls[0]![0];
    expect(ingestArgs.namespace).toBe(clientTenantNamespace(clientId));
    expect(ingestArgs.extraMetadata).toMatchObject({
      scope: 'client',
      clientId,
      documentType: 'contracts',
    });

    // documentCount on the client increments
    const after = await request(app)
      .get(`/api/clients/${clientId}`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(after.body.client.documentCount).toBe(1);
  });

  it('rejects unknown documentType with 422', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const clientId = await createClientForTest(app, cookieHeader);

    const res = await request(app)
      .post(`/api/clients/${clientId}/documents`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('documentType', 'invalidType')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'x.pdf');

    expect(res.status).toBe(422);
    expect(putClientObject).not.toHaveBeenCalled();
  });

  it('rejects upload to a client owned by another firm', async () => {
    const app = createApp();
    const firmA = await createUserWithSessionCookie(app);
    const firmB = await createUserWithSessionCookie(app);
    const aClientId = await createClientForTest(app, firmA.cookieHeader);

    const res = await request(app)
      .post(`/api/clients/${aClientId}/documents`)
      .set('Cookie', firmB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('documentType', 'contracts')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'doc.pdf');

    expect(res.status).toBe(404);
    expect(putClientObject).not.toHaveBeenCalled();
    expect(ingestPdfToPinecone).not.toHaveBeenCalled();
  });

  it('deletes vectors in the client namespace and removes the S3 object', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const clientId = await createClientForTest(app, cookieHeader);

    const up = await request(app)
      .post(`/api/clients/${clientId}/documents`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('documentType', 'policies')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'policy.pdf');
    expect(up.status).toBe(201);
    const s3Key = up.body.document.s3Key as string;

    const del = await request(app)
      .delete(`/api/clients/${clientId}/documents`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ s3Key });
    expect(del.status).toBe(200);

    expect(deleteKnowledgeVectorsByS3Key).toHaveBeenCalledWith(
      s3Key,
      clientTenantNamespace(clientId),
    );
    expect(deleteClientObject).toHaveBeenCalledWith(s3Key, expect.any(String), clientId);
  });

  it('refuses to delete a key from a different client (forged key)', async () => {
    const app = createApp();
    const { cookieHeader } = await createUserWithSessionCookie(app);
    const clientId = await createClientForTest(app, cookieHeader);
    const otherClientId = await createClientForTest(app, cookieHeader);

    // Upload under the second client, then try to delete via the first client's URL.
    const up = await request(app)
      .post(`/api/clients/${otherClientId}/documents`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .field('documentType', 'other')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'foreign.pdf');
    const foreignKey = up.body.document.s3Key as string;

    const res = await request(app)
      .delete(`/api/clients/${clientId}/documents`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ s3Key: foreignKey });
    expect(res.status).toBe(404);
    expect(deleteClientObject).not.toHaveBeenCalled();
  });
});
