import { getPineconeClient } from '../lib/pinecone.js';
import { env } from '../config/env.js';

/**
 * Remove all Pinecone chunks whose metadata `s3Key` matches, within a given namespace.
 * Pinecone filter-based deletes are scoped per-namespace.
 *
 * @param s3Key - The S3 key whose chunks should be removed
 * @param namespace - The namespace the chunks live in. Defaults to '' (legacy/global pre-multitenant).
 */
export async function deleteKnowledgeVectorsByS3Key(
  s3Key: string,
  namespace: string = '',
): Promise<void> {
  const index = getPineconeClient().Index(env.PINECONE_INDEX);
  const ns = index.namespace(namespace);
  await ns.deleteMany({
    filter: { s3Key: { $eq: s3Key } },
  });
}
