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
import { ingestPdfToPinecone } from '../rag/ingest.js';
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

      const { key, url } = await putClientObject(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        firmId,
        client.id,
        body.documentType,
      );

      const message = await ingestPdfToPinecone({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        s3Key: key,
        s3Url: url,
        namespace: clientTenantNamespace(client.id),
        extraMetadata: {
          scope: 'client',
          firmId,
          clientId: client.id,
          documentType: body.documentType,
        },
      });

      try {
        await recordClientDocument({
          s3Key: key,
          organizationId: firmId,
          clientId: client.id,
          documentType: body.documentType,
          originalName: req.file.originalname,
          displayName,
          uploadedAt: new Date(),
          uploadedBy: req.user!.id,
          sizeBytes: req.file.size ?? 0,
        });
        await incrementClientDocumentCount(firmId, client.id, 1);
      } catch (err) {
        logger.warn(
          { err, key },
          'Failed to record client document metadata (S3/Pinecone already committed)',
        );
      }

      res.status(201).json({
        status: 'success',
        message,
        document: {
          s3Key: key,
          url,
          documentType: body.documentType,
          displayName,
          originalName: req.file.originalname,
        },
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

      await deleteKnowledgeVectorsByS3Key(key, clientTenantNamespace(client.id));
      await deleteClientObject(key, req.activeOrgId!, client.id);
      const removed = await deleteClientDocument({
        organizationId: req.activeOrgId!,
        clientId: client.id,
        s3Key: key,
      });
      if (removed) {
        await incrementClientDocumentCount(req.activeOrgId!, client.id, -1);
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
