import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import {
  createUserWithSessionCookie,
  getPrimaryOrgIdForUser,
  setUserRole,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

vi.mock('../src/rag/delete-knowledge.js', () => ({
  deleteKnowledgeVectorsByS3Key: vi.fn(async () => {}),
}));

vi.mock('../src/lib/s3.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/s3.js')>('../src/lib/s3.js');
  return {
    ...actual,
    listKnowledgeObjects: vi.fn(async (organizationId: string) => ({
      items: [
        {
          key: `knowledge/${organizationId}/sample.pdf`,
          name: 'sample.pdf',
          size: 99,
          lastModified: new Date('2026-01-02T12:00:00.000Z').toISOString(),
          url: 'https://example.com/knowledge/sample.pdf',
        },
      ],
      nextContinuationToken: null,
    })),
    deleteKnowledgeObject: vi.fn(async () => {}),
  };
});

vi.mock('../src/lib/knowledge-files.js', () => ({
  ensureKnowledgeFileIndexes: vi.fn(async () => {}),
  getKnowledgeFileMetaForKeys: vi.fn(async (keys: string[]) => {
    const m = new Map<string, { originalName: string; displayName: string }>();
    for (const k of keys) {
      m.set(k, { originalName: 'uploaded-sample.pdf', displayName: 'Pretty label' });
    }
    return m;
  }),
  deleteKnowledgeFileByS3Key: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { listKnowledgeObjects } = await import('../src/lib/s3.js');
const { deleteKnowledgeFileByS3Key } = await import('../src/lib/knowledge-files.js');

describe('admin knowledge-files metadata', () => {
  beforeEach(() => {
    vi.mocked(listKnowledgeObjects).mockClear();
    vi.mocked(deleteKnowledgeFileByS3Key).mockClear();
  });

  it('GET /admin/knowledge-files merges Mongo displayName into listing', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    await setUserRole(userId, 'admin');
    const orgId = await getPrimaryOrgIdForUser(userId);

    const res = await request(app)
      .get('/admin/knowledge-files')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      key: `knowledge/${orgId}/sample.pdf`,
      name: 'uploaded-sample.pdf',
      displayName: 'Pretty label',
      size: 99,
    });
    expect(listKnowledgeObjects).toHaveBeenCalledWith(orgId, expect.any(Object));
  });

  it('DELETE /admin/knowledge-files removes Mongo metadata after storage cleanup', async () => {
    const app = createApp();
    const { cookieHeader, userId } = await createUserWithSessionCookie(app);
    await setUserRole(userId, 'admin');
    const orgId = await getPrimaryOrgIdForUser(userId);
    const key = `knowledge/${orgId}/sample.pdf`;

    const res = await request(app)
      .delete('/admin/knowledge-files')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ key });

    expect(res.status).toBe(200);
    expect(deleteKnowledgeFileByS3Key).toHaveBeenCalledWith(key);
  });
});
