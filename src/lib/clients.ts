import { ObjectId } from 'mongodb';
import { getDb } from './mongo.js';
import { logger } from './logger.js';

export const CLIENT_COLLECTION = 'client';

export type ClientDoc = {
  _id: ObjectId;
  id: string;
  organizationId: string;
  name: string;
  industry: string | null;
  description: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  documentCount: number;
};

export type SerializedClient = {
  id: string;
  organizationId: string;
  name: string;
  industry: string | null;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  documentCount: number;
};

let indexesEnsured = false;

export async function ensureClientIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const db = await getDb();
  const col = db.collection<ClientDoc>(CLIENT_COLLECTION);
  await col.createIndex({ organizationId: 1, archivedAt: 1, createdAt: -1 });
  await col.createIndex({ organizationId: 1, name: 1 });
  indexesEnsured = true;
  logger.info({ collection: CLIENT_COLLECTION }, 'Client indexes ensured');
}

export function serializeClient(doc: ClientDoc): SerializedClient {
  return {
    id: doc.id,
    organizationId: doc.organizationId,
    name: doc.name,
    industry: doc.industry,
    description: doc.description,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    archivedAt: doc.archivedAt ? doc.archivedAt.toISOString() : null,
    documentCount: doc.documentCount,
  };
}

export async function createClient(input: {
  organizationId: string;
  name: string;
  industry?: string | null;
  description?: string | null;
  createdBy: string;
}): Promise<ClientDoc> {
  await ensureClientIndexes();
  const db = await getDb();
  const now = new Date();
  const _id = new ObjectId();
  const doc: ClientDoc = {
    _id,
    id: _id.toHexString(),
    organizationId: input.organizationId,
    name: input.name,
    industry: input.industry ?? null,
    description: input.description ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    documentCount: 0,
  };
  await db.collection<ClientDoc>(CLIENT_COLLECTION).insertOne(doc);
  return doc;
}

function clientFilter(organizationId: string, clientId: string): Record<string, unknown> {
  const candidates: Record<string, unknown>[] = [{ id: clientId }];
  if (ObjectId.isValid(clientId)) candidates.push({ _id: new ObjectId(clientId) });
  return { organizationId, $or: candidates };
}

export async function getClientForOrg(
  organizationId: string,
  clientId: string,
): Promise<ClientDoc | null> {
  await ensureClientIndexes();
  const db = await getDb();
  return db.collection<ClientDoc>(CLIENT_COLLECTION).findOne(clientFilter(organizationId, clientId));
}

export async function listClientsForOrg(opts: {
  organizationId: string;
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
  search?: string;
}): Promise<{ items: ClientDoc[]; nextCursor: string | null; hasMore: boolean }> {
  await ensureClientIndexes();
  const db = await getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const filter: Record<string, unknown> = { organizationId: opts.organizationId };
  if (!opts.includeArchived) filter['archivedAt'] = null;
  if (opts.search?.trim()) filter['name'] = { $regex: opts.search.trim(), $options: 'i' };
  if (opts.cursor && ObjectId.isValid(opts.cursor)) {
    filter['_id'] = { $lt: new ObjectId(opts.cursor) };
  }
  const docs = await db
    .collection<ClientDoc>(CLIENT_COLLECTION)
    .find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .toArray();
  const hasMore = docs.length > limit;
  const items = docs.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last._id.toHexString() : null;
  return { items, nextCursor, hasMore };
}

export async function updateClient(
  organizationId: string,
  clientId: string,
  patch: { name?: string; industry?: string | null; description?: string | null },
): Promise<ClientDoc | null> {
  await ensureClientIndexes();
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) set['name'] = patch.name;
  if (patch.industry !== undefined) set['industry'] = patch.industry;
  if (patch.description !== undefined) set['description'] = patch.description;
  const result = await db
    .collection<ClientDoc>(CLIENT_COLLECTION)
    .findOneAndUpdate(clientFilter(organizationId, clientId), { $set: set }, { returnDocument: 'after' });
  return result ?? null;
}

export async function archiveClient(
  organizationId: string,
  clientId: string,
): Promise<ClientDoc | null> {
  await ensureClientIndexes();
  const db = await getDb();
  const now = new Date();
  const result = await db
    .collection<ClientDoc>(CLIENT_COLLECTION)
    .findOneAndUpdate(
      clientFilter(organizationId, clientId),
      { $set: { archivedAt: now, updatedAt: now } },
      { returnDocument: 'after' },
    );
  return result ?? null;
}

export async function incrementClientDocumentCount(
  organizationId: string,
  clientId: string,
  delta: number,
): Promise<void> {
  await ensureClientIndexes();
  const db = await getDb();
  await db
    .collection<ClientDoc>(CLIENT_COLLECTION)
    .updateOne(clientFilter(organizationId, clientId), {
      $inc: { documentCount: delta },
      $set: { updatedAt: new Date() },
    });
}
