import { getDb } from './mongo.js';
import { logger } from './logger.js';

export const KNOWLEDGE_FILES_COLLECTION = 'knowledge_files';

export type KnowledgeFileDoc = {
  s3Key: string;
  organizationId: string;
  originalName: string;
  displayName: string;
  uploadedAt: Date;
  uploadedBy: string;
  sizeBytes: number;
};

let indexesEnsured = false;

export async function ensureKnowledgeFileIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const db = await getDb();
  const col = db.collection<KnowledgeFileDoc>(KNOWLEDGE_FILES_COLLECTION);
  await col.createIndex({ s3Key: 1 }, { unique: true });
  await col.createIndex({ organizationId: 1, uploadedAt: -1 });
  indexesEnsured = true;
  logger.info({ collection: KNOWLEDGE_FILES_COLLECTION }, 'Knowledge file indexes ensured');
}

export async function recordKnowledgeFile(doc: KnowledgeFileDoc): Promise<void> {
  await ensureKnowledgeFileIndexes();
  const db = await getDb();
  await db.collection<KnowledgeFileDoc>(KNOWLEDGE_FILES_COLLECTION).insertOne(doc);
}

/** Metadata for admin listing / ingest joins */
export async function getKnowledgeFileMetaForKeys(
  keys: string[],
): Promise<Map<string, { originalName: string; displayName: string }>> {
  const out = new Map<string, { originalName: string; displayName: string }>();
  const uniq = [...new Set(keys.filter((k) => k.length > 0))];
  if (uniq.length === 0) return out;

  await ensureKnowledgeFileIndexes();
  const db = await getDb();
  const col = db.collection<KnowledgeFileDoc>(KNOWLEDGE_FILES_COLLECTION);
  const docs = await col
    .find({ s3Key: { $in: uniq } })
    .project({ s3Key: 1, originalName: 1, displayName: 1 })
    .toArray();

  for (const d of docs) {
    const key = d.s3Key as string;
    const originalName = typeof d.originalName === 'string' ? d.originalName : '';
    const displayName = typeof d.displayName === 'string' ? d.displayName : originalName;
    out.set(key, { originalName, displayName });
  }
  return out;
}

/** Retrieve step: map s3Key → display label */
export async function getDisplayNamesForS3Keys(keys: string[]): Promise<Map<string, string>> {
  const meta = await getKnowledgeFileMetaForKeys(keys);
  const out = new Map<string, string>();
  for (const [k, v] of meta) {
    out.set(k, v.displayName || v.originalName);
  }
  return out;
}

export async function deleteKnowledgeFileByS3Key(s3Key: string): Promise<void> {
  await ensureKnowledgeFileIndexes();
  const db = await getDb();
  await db.collection<KnowledgeFileDoc>(KNOWLEDGE_FILES_COLLECTION).deleteOne({ s3Key });
}

export async function upsertKnowledgeFileBackfill(doc: KnowledgeFileDoc): Promise<void> {
  await ensureKnowledgeFileIndexes();
  const db = await getDb();
  const col = db.collection<KnowledgeFileDoc>(KNOWLEDGE_FILES_COLLECTION);
  await col.updateOne(
    { s3Key: doc.s3Key },
    {
      $setOnInsert: {
        s3Key: doc.s3Key,
        organizationId: doc.organizationId,
        originalName: doc.originalName,
        displayName: doc.displayName,
        uploadedAt: doc.uploadedAt,
        uploadedBy: doc.uploadedBy,
        sizeBytes: doc.sizeBytes,
      },
    },
    { upsert: true },
  );
}
