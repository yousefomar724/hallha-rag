import { getDb } from './mongo.js';
import { logger } from './logger.js';
import type { ClientDocumentType } from './client-schema.js';

export const CLIENT_DOCUMENT_COLLECTION = 'client_document';

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
  };
}

export async function recordClientDocument(doc: ClientDocumentDoc): Promise<void> {
  await ensureClientDocumentIndexes();
  const db = await getDb();
  await db.collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION).insertOne(doc);
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
