import { getDb } from './mongo.js';
import { logger } from './logger.js';
import type { ClientDocumentType } from './client-schema.js';

export const CLIENT_DOCUMENT_COLLECTION = 'client_document';

/** Lifecycle of an uploaded client document. Legacy rows (pre-async-ingest) lack this
 *  field; reads default them to 'ready' so existing UIs keep working. */
export type ClientDocumentStatus = 'pending' | 'ready' | 'failed';

export type ClientDocumentDoc = {
  s3Key: string;
  organizationId: string;
  clientId: string;
  documentType: ClientDocumentType;
  originalName: string;
  displayName: string;
  uploadedAt: Date;
  uploadedBy: string;
  sizeBytes: number;
  status?: ClientDocumentStatus;
  error?: string | null;
  chunkCount?: number | null;
  /** Set when ingest finishes (ready) or fails. */
  processedAt?: Date | null;
};

export type SerializedClientDocument = {
  s3Key: string;
  organizationId: string;
  clientId: string;
  documentType: ClientDocumentType;
  originalName: string;
  displayName: string;
  uploadedAt: string;
  uploadedBy: string;
  sizeBytes: number;
  status: ClientDocumentStatus;
  error: string | null;
  chunkCount: number | null;
  processedAt: string | null;
};

let indexesEnsured = false;

export async function ensureClientDocumentIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const db = await getDb();
  const col = db.collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION);
  await col.createIndex({ s3Key: 1 }, { unique: true });
  await col.createIndex({ organizationId: 1, clientId: 1, uploadedAt: -1 });
  indexesEnsured = true;
  logger.info({ collection: CLIENT_DOCUMENT_COLLECTION }, 'Client document indexes ensured');
}

export function serializeClientDocument(doc: ClientDocumentDoc): SerializedClientDocument {
  return {
    s3Key: doc.s3Key,
    organizationId: doc.organizationId,
    clientId: doc.clientId,
    documentType: doc.documentType,
    originalName: doc.originalName,
    displayName: doc.displayName,
    uploadedAt: doc.uploadedAt.toISOString(),
    uploadedBy: doc.uploadedBy,
    sizeBytes: doc.sizeBytes,
    status: doc.status ?? 'ready',
    error: doc.error ?? null,
    chunkCount: doc.chunkCount ?? null,
    processedAt: doc.processedAt ? doc.processedAt.toISOString() : null,
  };
}

export async function recordClientDocument(doc: ClientDocumentDoc): Promise<void> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  await db.collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION).insertOne(doc);
}

/** Lookup by Mongo `_id`-equivalent: we already use s3Key as the unique key, but the new
 *  async-ingest flow needs to address a document by an id that's known before ingest finishes.
 *  We treat the s3Key as the document id (it's URL-safe-ish and already unique). */
export async function getClientDocumentById(opts: {
  organizationId: string;
  clientId: string;
  documentId: string; // == s3Key
}): Promise<ClientDocumentDoc | null> {
  return getClientDocumentByKey({
    organizationId: opts.organizationId,
    clientId: opts.clientId,
    s3Key: opts.documentId,
  });
}

export async function setClientDocumentStatus(opts: {
  s3Key: string;
  status: ClientDocumentStatus;
  error?: string | null;
  chunkCount?: number | null;
}): Promise<void> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  await db.collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION).updateOne(
    { s3Key: opts.s3Key },
    {
      $set: {
        status: opts.status,
        error: opts.error ?? null,
        chunkCount: opts.chunkCount ?? null,
        processedAt: new Date(),
      },
    },
  );
}

/** Used by boot-time janitor: find documents stuck in 'pending' beyond a threshold. */
export async function listStalePendingDocuments(olderThanMs: number): Promise<ClientDocumentDoc[]> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanMs);
  return db
    .collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION)
    .find({ status: 'pending', uploadedAt: { $lt: cutoff } })
    .toArray();
}

export async function listClientDocuments(opts: {
  organizationId: string;
  clientId: string;
  documentType?: ClientDocumentType;
  limit?: number;
}): Promise<ClientDocumentDoc[]> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  const filter: Record<string, unknown> = {
    organizationId: opts.organizationId,
    clientId: opts.clientId,
  };
  if (opts.documentType) filter['documentType'] = opts.documentType;
  return db
    .collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION)
    .find(filter)
    .sort({ uploadedAt: -1 })
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500))
    .toArray();
}

export async function getClientDocumentByKey(opts: {
  organizationId: string;
  clientId: string;
  s3Key: string;
}): Promise<ClientDocumentDoc | null> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  return db.collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION).findOne({
    s3Key: opts.s3Key,
    organizationId: opts.organizationId,
    clientId: opts.clientId,
  });
}

export async function deleteClientDocument(opts: {
  organizationId: string;
  clientId: string;
  s3Key: string;
}): Promise<boolean> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  const r = await db.collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION).deleteOne({
    s3Key: opts.s3Key,
    organizationId: opts.organizationId,
    clientId: opts.clientId,
  });
  return (r.deletedCount ?? 0) > 0;
}
