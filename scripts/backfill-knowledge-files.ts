/**
 * Idempotent backfill of `knowledge_files` from existing S3 keys under `knowledge/<orgId>/`.
 *
 * Usage: pnpm backfill:knowledge-files  (loads `.env` via package.json script)
 */
import { displayNameFromObjectKey, listKnowledgeObjects } from '../src/lib/s3.js';
import {
  ensureKnowledgeFileIndexes,
  upsertKnowledgeFileBackfill,
} from '../src/lib/knowledge-files.js';
import { closeMongo, getDb } from '../src/lib/mongo.js';
import { logger } from '../src/lib/logger.js';

async function main(): Promise<void> {
  try {
    await ensureKnowledgeFileIndexes();
    const db = await getDb();
    const orgs = await db.collection('organization').find({}).project({ id: 1, _id: 1 }).toArray();

    let keysSeen = 0;
    for (const o of orgs) {
      const orgId =
        typeof o.id === 'string' && o.id.trim().length > 0 ? o.id.trim() : String(o._id);

      let continuationToken: string | undefined;
      for (;;) {
        const { items, nextContinuationToken } = await listKnowledgeObjects(orgId, {
          continuationToken,
        });

        for (const item of items) {
          keysSeen++;
          const fallbackLabel = displayNameFromObjectKey(item.key);
          await upsertKnowledgeFileBackfill({
            s3Key: item.key,
            organizationId: orgId,
            originalName: fallbackLabel,
            displayName: fallbackLabel,
            uploadedAt: new Date(item.lastModified),
            uploadedBy: 'backfill',
            sizeBytes: item.size,
          });
        }

        if (!nextContinuationToken) break;
        continuationToken = nextContinuationToken;
      }
    }

    logger.info({ keysSeen, organizations: orgs.length }, 'Knowledge files backfill completed');
  } finally {
    await closeMongo();
  }
}

void main().catch((err) => {
  logger.error({ err }, 'Knowledge files backfill failed');
  process.exit(1);
});
