import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from '@langchain/pinecone';
import { env } from '../config/env.js';
import { getEmbeddings } from './embeddings.js';

let pineconeClient: Pinecone | null = null;

export const GLOBAL_AAOIFI_NAMESPACE = 'global_aaoifi';

export function clientTenantNamespace(clientId: string): string {
  return `client_tenant_${clientId}`;
}

export function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  }
  return pineconeClient;
}

const vectorStoreCache = new Map<string, PineconeStore>();

export async function getVectorStoreForNamespace(namespace: string): Promise<PineconeStore> {
  const cached = vectorStoreCache.get(namespace);
  if (cached) return cached;
  const pineconeIndex = getPineconeClient().Index(env.PINECONE_INDEX);
  const store = await PineconeStore.fromExistingIndex(getEmbeddings(), {
    pineconeIndex,
    namespace,
    maxConcurrency: 5,
  });
  vectorStoreCache.set(namespace, store);
  return store;
}

/**
 * Back-compat: the empty namespace (pre-multitenant data lives here).
 * New writes should target either GLOBAL_AAOIFI_NAMESPACE or clientTenantNamespace(...).
 */
export async function getVectorStore(): Promise<PineconeStore> {
  return getVectorStoreForNamespace('');
}

export async function getRetriever(k = 4) {
  const store = await getVectorStore();
  return store.asRetriever({ k });
}

export async function getRetrieverForNamespace(namespace: string, k = 4) {
  const store = await getVectorStoreForNamespace(namespace);
  return store.asRetriever({ k });
}
