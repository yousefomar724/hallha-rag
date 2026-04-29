import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from '@langchain/pinecone';
import { env } from '../config/env.js';
import { getEmbeddings } from './embeddings.js';

let pineconeClient: Pinecone | null = null;
let vectorStore: PineconeStore | null = null;

export function getPineconeClient(): Pinecone {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: env.PINECONE_API_KEY });
  }
  return pineconeClient;
}

export async function getVectorStore(): Promise<PineconeStore> {
  if (!vectorStore) {
    const pineconeIndex = getPineconeClient().Index(env.PINECONE_INDEX);
    vectorStore = await PineconeStore.fromExistingIndex(getEmbeddings(), {
      pineconeIndex,
      maxConcurrency: 5,
    });
  }
  return vectorStore;
}

export async function getRetriever(k = 4) {
  const store = await getVectorStore();
  return store.asRetriever({ k });
}
