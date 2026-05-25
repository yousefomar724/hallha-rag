import type { Document } from '@langchain/core/documents';
import {
  GLOBAL_AAOIFI_NAMESPACE,
  clientTenantNamespace,
  getPineconeClient,
  getRetrieverForNamespace,
} from '../lib/pinecone.js';
import { logger } from '../lib/logger.js';

export type ScopedDocument = Document & {
  __scope: 'global' | 'client';
  __namespace: string;
};

export type RetrievalCandidate = {
  doc: ScopedDocument;
  /** Position-derived initial score: kPerNamespace - rank, before bias / rerank. */
  baseScore: number;
};

export const CLIENT_BIAS_MULTIPLIER = 1.15;
export const DEFAULT_K_PER_NAMESPACE = 6;
export const DEFAULT_TOP_N = 8;

/**
 * Pinecone's cross-encoder (`bge-reranker-v2-m3`) caps each query+document pair
 * at 1024 tokens. Anything bigger 400s the whole rerank call. ~1 200 chars
 * ≈ 300 tokens for the query leaves room for ~700 tokens of document text per
 * pair. Combined with `parameters.truncate: 'END'` below this gives us
 * belt-and-suspenders against oversized inputs.
 */
const MAX_RERANK_QUERY_CHARS = 1_200;

/**
 * Query multiple Pinecone namespaces in parallel and return all hits tagged
 * with the namespace they came from. Order within each namespace is preserved
 * via the `baseScore` field (kPerNamespace - rank).
 */
export async function retrieveAcrossNamespaces(opts: {
  query: string;
  globalNamespace?: string;
  clientId?: string | null;
  kPerNamespace?: number;
}): Promise<RetrievalCandidate[]> {
  const k = opts.kPerNamespace ?? DEFAULT_K_PER_NAMESPACE;
  const globalNs = opts.globalNamespace ?? GLOBAL_AAOIFI_NAMESPACE;

  const namespaces: { ns: string; scope: 'global' | 'client' }[] = [
    { ns: globalNs, scope: 'global' },
  ];
  if (opts.clientId) {
    namespaces.push({ ns: clientTenantNamespace(opts.clientId), scope: 'client' });
  }

  const settled = await Promise.allSettled(
    namespaces.map(async ({ ns, scope }) => {
      const retriever = await getRetrieverForNamespace(ns, k);
      const docs = await retriever.invoke(opts.query);
      return docs.map((d, i) => ({
        doc: Object.assign({}, d, { __scope: scope, __namespace: ns }) as ScopedDocument,
        baseScore: k - i,
      })) as RetrievalCandidate[];
    }),
  );

  const out: RetrievalCandidate[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    if (r.status === 'fulfilled') {
      out.push(...r.value);
    } else {
      logger.warn(
        { err: r.reason, namespace: namespaces[i]!.ns },
        'Namespace retrieval failed; continuing with remaining namespaces',
      );
    }
  }
  return out;
}

/**
 * Apply a small multiplicative bias toward documents from the client namespace,
 * reflecting the auditing-firm intuition that the user's question is usually
 * about THIS client's contract clause, with AAOIFI rules as supporting context.
 */
export function applyClientBias(
  candidates: RetrievalCandidate[],
  bias: number = CLIENT_BIAS_MULTIPLIER,
): RetrievalCandidate[] {
  return candidates.map((c) => ({
    ...c,
    baseScore: c.doc.__scope === 'client' ? c.baseScore * bias : c.baseScore,
  }));
}

type RerankResult = {
  ordered: RetrievalCandidate[];
  reranked: boolean;
};

/**
 * Cross-encoder rerank via Pinecone Inference. Falls back to baseScore order
 * on any failure (network, model unavailability, malformed response) — we
 * never want to fail the whole chat over a missing rerank.
 */
export async function rerankDocuments(opts: {
  query: string;
  candidates: RetrievalCandidate[];
  topN?: number;
  model?: string;
}): Promise<RerankResult> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const model = opts.model ?? 'bge-reranker-v2-m3';

  if (opts.candidates.length === 0) {
    return { ordered: [], reranked: false };
  }

  const documents = opts.candidates.map((c, i) => ({
    id: String(i),
    text: c.doc.pageContent,
  }));

  const query =
    opts.query.length > MAX_RERANK_QUERY_CHARS
      ? opts.query.slice(0, MAX_RERANK_QUERY_CHARS)
      : opts.query;

  try {
    const pc = getPineconeClient() as unknown as {
      inference?: { rerank: (req: unknown) => Promise<unknown> };
    };
    if (!pc.inference?.rerank) {
      throw new Error('Pinecone inference rerank API unavailable');
    }
    const raw = (await pc.inference.rerank({
      model,
      query,
      documents,
      topN,
      returnDocuments: false,
      rankFields: ['text'],
      parameters: { truncate: 'END' },
    })) as { data?: { index?: number; score?: number }[] };

    const ranked = Array.isArray(raw?.data) ? raw.data : [];
    if (ranked.length === 0) throw new Error('Empty rerank response');

    const ordered: RetrievalCandidate[] = [];
    for (const row of ranked) {
      const idx = typeof row.index === 'number' ? row.index : -1;
      const candidate = opts.candidates[idx];
      if (candidate) ordered.push(candidate);
    }
    return { ordered: ordered.slice(0, topN), reranked: true };
  } catch (err) {
    logger.warn({ err }, 'Rerank failed; falling back to score-merged top-N');
    const sorted = [...opts.candidates].sort((a, b) => b.baseScore - a.baseScore);
    return { ordered: sorted.slice(0, topN), reranked: false };
  }
}

/** Convenience: end-to-end hybrid retrieval. */
export async function hybridRetrieve(opts: {
  query: string;
  clientId: string | null;
  kPerNamespace?: number;
  topN?: number;
}): Promise<{ ordered: RetrievalCandidate[]; reranked: boolean }> {
  const candidates = await retrieveAcrossNamespaces({
    query: opts.query,
    clientId: opts.clientId,
    kPerNamespace: opts.kPerNamespace,
  });
  const biased = applyClientBias(candidates);
  return rerankDocuments({ query: opts.query, candidates: biased, topN: opts.topN });
}
