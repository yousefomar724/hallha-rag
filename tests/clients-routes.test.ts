import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import {
  createUserWithSessionCookie,
  TEST_AUTH_ORIGIN,
} from './test-helpers/auth-flow.js';

const { createApp } = await import('../src/app.js');

describe('/api/clients CRUD', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    app = createApp();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/clients').set('Origin', TEST_AUTH_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('creates a client and returns it in the list', async () => {
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const create = await request(app)
      .post('/api/clients')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'Bank Alpha', industry: 'Banking' });
    expect(create.status).toBe(201);
    expect(create.body.client.name).toBe('Bank Alpha');
    expect(create.body.client.industry).toBe('Banking');
    expect(create.body.client.documentCount).toBe(0);
    expect(create.body.client.archivedAt).toBeNull();

    const list = await request(app)
      .get('/api/clients')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(create.body.client.id);
  });

  it('rejects invalid create body with 422', async () => {
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const res = await request(app)
      .post('/api/clients')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: '' });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/name/i);
  });

  it('isolates clients across firms: firm B cannot see firm A clients', async () => {
    const firmA = await createUserWithSessionCookie(app);
    const firmB = await createUserWithSessionCookie(app);

    const created = await request(app)
      .post('/api/clients')
      .set('Cookie', firmA.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'Private Client A' });
    expect(created.status).toBe(201);
    const clientId = created.body.client.id as string;

    const listB = await request(app)
      .get('/api/clients')
      .set('Cookie', firmB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(listB.status).toBe(200);
    expect(listB.body.items).toHaveLength(0);

    const getB = await request(app)
      .get(`/api/clients/${clientId}`)
      .set('Cookie', firmB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(getB.status).toBe(404);

    const patchB = await request(app)
      .patch(`/api/clients/${clientId}`)
      .set('Cookie', firmB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'Hijack' });
    expect(patchB.status).toBe(404);

    const archiveB = await request(app)
      .post(`/api/clients/${clientId}/archive`)
      .set('Cookie', firmB.cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(archiveB.status).toBe(404);
  });

  it('patches name and archives a client', async () => {
    const { cookieHeader } = await createUserWithSessionCookie(app);

    const created = await request(app)
      .post('/api/clients')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'Working Name' });
    const id = created.body.client.id as string;

    const patched = await request(app)
      .patch(`/api/clients/${id}`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN)
      .send({ name: 'Renamed', description: 'Updated' });
    expect(patched.status).toBe(200);
    expect(patched.body.client.name).toBe('Renamed');
    expect(patched.body.client.description).toBe('Updated');

    const archived = await request(app)
      .post(`/api/clients/${id}/archive`)
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(archived.status).toBe(200);
    expect(archived.body.client.archivedAt).not.toBeNull();

    const list = await request(app)
      .get('/api/clients')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    // archived clients are excluded from the default list
    expect(list.body.items.every((c: { id: string }) => c.id !== id)).toBe(true);

    const listAll = await request(app)
      .get('/api/clients?includeArchived=true')
      .set('Cookie', cookieHeader)
      .set('Origin', TEST_AUTH_ORIGIN);
    expect(listAll.body.items.some((c: { id: string }) => c.id === id)).toBe(true);
  });
});
