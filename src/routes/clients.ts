import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/require-auth.js';
import { memoryUpload } from '../middleware/upload.js';
import { HttpError } from '../middleware/error.js';
import { uploadClientDocDailyLimiter } from '../middleware/rate-limit.js';
import {
  archiveClient,
  createClient,
  getClientForOrg,
  incrementClientDocumentCount,
  listClientsForOrg,
  serializeClient,
  updateClient,
} from '../lib/clients.js';
import {
  createClientBodySchema,
  updateClientBodySchema,
  uploadClientDocumentBodySchema,
} from '../lib/client-schema.js';
import {
  deleteClientDocument,
  getClientDocumentByKey,
  listClientDocuments,
  recordClientDocument,
  serializeClientDocument,
} from '../lib/client-documents.js';
import {
  deleteClientObject,
  putClientObject,
} from '../lib/s3.js';
import { processClientDocumentIngest } from '../lib/client-ingest.js';
import { clientTenantNamespace } from '../lib/pinecone.js';
import { deleteKnowledgeVectorsByS3Key } from '../rag/delete-knowledge.js';
import { logger } from '../lib/logger.js';

export const clientsRouter: Router = Router();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? 'body';
    throw new HttpError(422, `Invalid ${path}: ${first?.message ?? 'invalid'}`);
  }
  return result.data;
}

clientsRouter.post('/api/clients', requireAuth, async (req, res, next) => {
  try {
    const body = parseBody(createClientBodySchema, req.body);
    const created = await createClient({
      organizationId: req.activeOrgId!,
      name: body.name,
      industry: body.industry ?? null,
      description: body.description ?? null,
      createdBy: req.user!.id,
    });
    res.status(201).json({ client: serializeClient(created) });
  } catch (err) {
    next(err);
  }
});

clientsRouter.get('/api/clients', requireAuth, async (req, res, next) => {
  try {
    const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;
    const includeArchived = req.query['includeArchived'] === 'true';
    const { items, nextCursor, hasMore } = await listClientsForOrg({
      organizationId: req.activeOrgId!,
      limit,
      cursor,
      search,
      includeArchived,
    });
    res.json({
      items: items.map(serializeClient),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    next(err);
  }
});

async function loadOwnedClient(req: { activeOrgId?: string; params: Record<string, string> }) {
  const clientId = req.params['clientId'];
  if (!clientId) throw new HttpError(400, 'Missing clientId in path.');
  const client = await getClientForOrg(req.activeOrgId!, clientId);
  if (!client) throw new HttpError(404, 'Client not found.');
  return client;
}

clientsRouter.get('/api/clients/:clientId', requireAuth, async (req, res, next) => {
  try {
    const client = await loadOwnedClient(req as never);
    res.json({ client: serializeClient(client) });
  } catch (err) {
    next(err);
  }
});

clientsRouter.patch('/api/clients/:clientId', requireAuth, async (req, res, next) => {
  try {
    const client = await loadOwnedClient(req as never);
    const body = parseBody(updateClientBodySchema, req.body);
    const updated = await updateClient(req.activeOrgId!, client.id, body);
    if (!updated) throw new HttpError(404, 'Client not found.');
    res.json({ client: serializeClient(updated) });
  } catch (err) {
    next(err);
  }
});

clientsRouter.post('/api/clients/:clientId/archive', requireAuth, async (req, res, next) => {
  try {
    const client = await loadOwnedClient(req as never);
    const archived = await archiveClient(req.activeOrgId!, client.id);
    if (!archived) throw new HttpError(404, 'Client not found.');
    res.json({ client: serializeClient(archived) });
  } catch (err) {
    next(err);
  }
});

clientsRouter.get(
  '/api/clients/:clientId/documents',
  requireAuth,
  async (req, res, next) => {
    try {
      const client = await loadOwnedClient(req as never);
      const documentType = req.query['documentType'];
      const docs = await listClientDocuments({
        organizationId: req.activeOrgId!,
        clientId: client.id,
        documentType:
          documentType === 'policies' ||
          documentType === 'contracts' ||
          documentType === 'financials' ||
          documentType === 'other'
            ? documentType
            : undefined,
      });
      res.json({ items: docs.map(serializeClientDocument) });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Upload a client document.
 *
 * Returns **202 Accepted** with `{ documentId, statusUrl, document }` after S3 transport
 * + Mongo row insert (~fast). The heavy work — PDF parse + embedding + Pinecone upsert —
 * runs in the background via `setImmediate`. Frontend polls `statusUrl` until status
 * flips to 'ready' or 'failed'. This avoids the production 504s caused by sync ingest
 * exceeding gateway timeouts (60s) on cold-start embedding model loads.
 */
clientsRouter.post(
  '/api/clients/:clientId/documents',
  requireAuth,
  uploadClientDocDailyLimiter,
  memoryUpload.single('file'),
  async (req, res, next) => {
    try {
      const client = await loadOwnedClient(req as never);
      if (!req.file?.buffer || req.file.buffer.length === 0) {
        throw new HttpError(400, 'Missing required field "file".');
      }
      const body = parseBody(uploadClientDocumentBodySchema, {
        documentType: req.body?.documentType,
        ...(typeof req.body?.displayName === 'string'
          ? { displayName: req.body.displayName }
          : {}),
      });
      const firmId = req.activeOrgId!;
      const displayName =
        body.displayName?.trim() && body.displayName.trim().length > 0
          ? body.displayName.trim()
          : req.file.originalname;

      // 1. Transport phase: write the file to S3.
      const { key, url } = await putClientObject(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        firmId,
        client.id,
        body.documentType,
      );

      // 2. Insert metadata row with status='pending'. We do NOT increment the
      //    client's documentCount yet — that happens once ingest succeeds, so the
      //    UI doesn't double-count failed uploads.
      const uploadedAt = new Date();
      try {
        await recordClientDocument({
          s3Key: key,
          organizationId: firmId,
          clientId: client.id,
          documentType: body.documentType,
          originalName: req.file.originalname,
          displayName,
          uploadedAt,
          uploadedBy: req.user!.id,
          sizeBytes: req.file.size ?? 0,
          status: 'pending',
          error: null,
          chunkCount: null,
          processedAt: null,
        });
      } catch (err) {
        logger.error({ err, key }, 'Failed to record pending client document metadata');
        throw new HttpError(500, 'Failed to record document. Please try again.');
      }

      // 3. Schedule the heavy work after the response is sent. The closure holds the
      //    buffer in memory until the background job completes, so we don't need to
      //    re-download from S3. Errors are handled inside processClientDocumentIngest
      //    (logged + status flipped to 'failed') — never rethrow here.
      const buffer = req.file.buffer;
      const originalName = req.file.originalname;
      setImmediate(() => {
        void processClientDocumentIngest({
          buffer,
          originalName,
          s3Key: key,
          s3Url: url,
          firmId,
          clientId: client.id,
          documentType: body.documentType,
        });
      });

      // 4. Respond immediately. Frontend polls the status endpoint.
      const statusUrl = `/api/clients/${client.id}/documents/${encodeURIComponent(key)}/status`;
      res.status(202).json({
        status: 'accepted',
        documentId: key,
        statusUrl,
        document: {
          s3Key: key,
          url,
          documentType: body.documentType,
          displayName,
          originalName: req.file.originalname,
          status: 'pending' as const,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Poll endpoint for async ingest. Returns the document's current status.
 * Frontend should poll every ~2s while status === 'pending' and stop once it flips.
 */
clientsRouter.get(
  '/api/clients/:clientId/documents/:documentId/status',
  requireAuth,
  async (req, res, next) => {
    try {
      const client = await loadOwnedClient(req as never);
      const rawDocId = req.params['documentId'];
      const documentId = typeof rawDocId === 'string' ? rawDocId : Array.isArray(rawDocId) ? rawDocId[0] : undefined;
      if (!documentId) throw new HttpError(400, 'Missing documentId in path.');
      const doc = await getClientDocumentByKey({
        organizationId: req.activeOrgId!,
        clientId: client.id,
        s3Key: documentId,
      });
      if (!doc) throw new HttpError(404, 'Document not found.');
      res.json({
        status: doc.status ?? 'ready',
        error: doc.error ?? null,
        chunkCount: doc.chunkCount ?? null,
        processedAt: doc.processedAt ? doc.processedAt.toISOString() : null,
        document: serializeClientDocument(doc),
      });
    } catch (err) {
      next(err);
    }
  },
);

clientsRouter.delete(
  '/api/clients/:clientId/documents',
  requireAuth,
  async (req, res, next) => {
    try {
      const client = await loadOwnedClient(req as never);
      const key = typeof req.body?.s3Key === 'string' ? req.body.s3Key.trim() : '';
      if (!key) throw new HttpError(400, 'Missing required field "s3Key".');

      // Ownership guard: the document row must belong to this firm+client.
      const existing = await getClientDocumentByKey({
        organizationId: req.activeOrgId!,
        clientId: client.id,
        s3Key: key,
      });
      if (!existing) throw new HttpError(404, 'Document not found for this client.');

      // Only 'ready' docs have Pinecone vectors and were counted toward documentCount.
      // Pending/failed docs may have a partial S3 object but no vectors.
      const wasReady = (existing.status ?? 'ready') === 'ready';
      if (wasReady) {
        await deleteKnowledgeVectorsByS3Key(key, clientTenantNamespace(client.id));
      }
      await deleteClientObject(key, req.activeOrgId!, client.id);
      const removed = await deleteClientDocument({
        organizationId: req.activeOrgId!,
        clientId: client.id,
        s3Key: key,
      });
      if (removed && wasReady) {
        await incrementClientDocumentCount(req.activeOrgId!, client.id, -1);
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
