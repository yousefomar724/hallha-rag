import { getPineconeClient } from '../lib/pinecone.js';
import { env } from '../config/env.js';

/** Remove all Pinecone chunks whose metadata `s3Key` matches (same namespace as ingest). */
export async function deleteKnowledgeVectorsByS3Key(s3Key: string): Promise<void> {
  const index = getPineconeClient().Index(env.PINECONE_INDEX);
  const ns = index.namespace('');
  await ns.deleteMany({
    filter: { s3Key: { $eq: s3Key } },
  });
}
