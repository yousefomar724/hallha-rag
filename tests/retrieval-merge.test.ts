import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Document } from '@langchain/core/documents';

const fakeRetrieve = vi.fn();

vi.mock('../src/lib/pinecone.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/lib/pinecone.js')>('../src/lib/pinecone.js');
  return {
    ...actual,
    getRetrieverForNamespace: vi.fn(async (namespace: string) => ({
      invoke: (q: string) => fakeRetrieve(namespace, q),
    })),
    getPineconeClient: vi.fn(() => ({
      inference: { rerank: vi.fn() },
    })),
  };
});

const {
  retrieveAcrossNamespaces,
  applyClientBias,
  rerankDocuments,
  hybridRetrieve,
  CLIENT_BIAS_MULTIPLIER,
} = await import('../src/agent/retrieval.js');
const { getPineconeClient, GLOBAL_AAOIFI_NAMESPACE, clientTenantNamespace } = await import(
  '../src/lib/pinecone.js'
);

function makeDoc(text: string, meta: Record<string, unknown> = {}): Document {
  return new Document({ pageContent: text, metadata: meta });
}

beforeEach(() => {
  fakeRetrieve.mockReset();
  vi.mocked(getPineconeClient).mockReset();
});

describe('retrieveAcrossNamespaces', () => {
  it('queries only the global namespace when clientId is null', async () => {
    fakeRetrieve.mockImplementation(async (ns: string) => {
      if (ns === GLOBAL_AAOIFI_NAMESPACE) return [makeDoc('AAOIFI rule 1'), makeDoc('rule 2')];
      return [];
    });

    const results = await retrieveAcrossNamespaces({ query: 'riba', clientId: null });

    expect(results).toHaveLength(2);
    expect(results.every((c) => c.doc.__scope === 'global')).toBe(true);
    expect(fakeRetrieve).toHaveBeenCalledTimes(1);
    expect(fakeRetrieve).toHaveBeenCalledWith(GLOBAL_AAOIFI_NAMESPACE, 'riba');
  });

  it('queries both namespaces in parallel when clientId is provided', async () => {
    fakeRetrieve.mockImplementation(async (ns: string) => {
      if (ns === GLOBAL_AAOIFI_NAMESPACE) return [makeDoc('AAOIFI'), makeDoc('AAOIFI 2')];
      return [makeDoc('Client clause A'), makeDoc('Client clause B')];
    });

    const results = await retrieveAcrossNamespaces({
      query: 'q',
      clientId: 'c1',
      kPerNamespace: 4,
    });

    expect(results).toHaveLength(4);
    expect(results.filter((c) => c.doc.__scope === 'global')).toHaveLength(2);
    expect(results.filter((c) => c.doc.__scope === 'client')).toHaveLength(2);

    const namespacesQueried = fakeRetrieve.mock.calls.map((c) => c[0]);
    expect(namespacesQueried).toContain(GLOBAL_AAOIFI_NAMESPACE);
    expect(namespacesQueried).toContain(clientTenantNamespace('c1'));
  });

  it('continues when one namespace retrieval fails', async () => {
    fakeRetrieve.mockImplementation(async (ns: string) => {
      if (ns === GLOBAL_AAOIFI_NAMESPACE) return [makeDoc('global only')];
      throw new Error('boom');
    });

    const results = await retrieveAcrossNamespaces({ query: 'q', clientId: 'c1' });
    expect(results).toHaveLength(1);
    expect(results[0]!.doc.__scope).toBe('global');
  });
});

describe('applyClientBias', () => {
  it('multiplies client-scope scores by the bias multiplier', async () => {
    fakeRetrieve.mockImplementation(async (ns: string) => {
      if (ns === GLOBAL_AAOIFI_NAMESPACE) return [makeDoc('g')];
      return [makeDoc('c')];
    });

    const candidates = await retrieveAcrossNamespaces({
      query: 'q',
      clientId: 'cx',
      kPerNamespace: 5,
    });
    const biased = applyClientBias(candidates);

    const globalCandidate = biased.find((b) => b.doc.__scope === 'global')!;
    const clientCandidate = biased.find((b) => b.doc.__scope === 'client')!;
    expect(globalCandidate.baseScore).toBe(5);
    expect(clientCandidate.baseScore).toBeCloseTo(5 * CLIENT_BIAS_MULTIPLIER, 6);
  });
});

describe('rerankDocuments', () => {
  it('uses Pinecone Inference rerank when available', async () => {
    const rerankMock = vi.fn(async () => ({
      data: [
        { index: 2, score: 0.9 },
        { index: 0, score: 0.6 },
      ],
    }));
    vi.mocked(getPineconeClient).mockReturnValue({
      inference: { rerank: rerankMock },
    } as never);

    const candidates = [
      { doc: Object.assign(makeDoc('a'), { __scope: 'global' as const, __namespace: '' }), baseScore: 3 },
      { doc: Object.assign(makeDoc('b'), { __scope: 'global' as const, __namespace: '' }), baseScore: 2 },
      { doc: Object.assign(makeDoc('c'), { __scope: 'client' as const, __namespace: 'x' }), baseScore: 1 },
    ];

    const { ordered, reranked } = await rerankDocuments({
      query: 'q',
      candidates,
      topN: 2,
    });

    expect(reranked).toBe(true);
    expect(ordered).toHaveLength(2);
    expect(ordered[0]!.doc.pageContent).toBe('c');
    expect(ordered[1]!.doc.pageContent).toBe('a');
    expect(rerankMock).toHaveBeenCalled();
  });

  it('falls back to baseScore order when rerank throws', async () => {
    const rerankMock = vi.fn(async () => {
      throw new Error('rerank service unavailable');
    });
    vi.mocked(getPineconeClient).mockReturnValue({
      inference: { rerank: rerankMock },
    } as never);

    const candidates = [
      { doc: Object.assign(makeDoc('low'), { __scope: 'global' as const, __namespace: '' }), baseScore: 1 },
      { doc: Object.assign(makeDoc('high'), { __scope: 'client' as const, __namespace: 'x' }), baseScore: 10 },
    ];

    const { ordered, reranked } = await rerankDocuments({
      query: 'q',
      candidates,
      topN: 2,
    });

    expect(reranked).toBe(false);
    expect(ordered[0]!.doc.pageContent).toBe('high');
    expect(ordered[1]!.doc.pageContent).toBe('low');
  });

  it('returns empty for empty input without calling rerank', async () => {
    const rerankMock = vi.fn();
    vi.mocked(getPineconeClient).mockReturnValue({
      inference: { rerank: rerankMock },
    } as never);

    const { ordered, reranked } = await rerankDocuments({ query: 'q', candidates: [] });
    expect(ordered).toEqual([]);
    expect(reranked).toBe(false);
    expect(rerankMock).not.toHaveBeenCalled();
  });
});

describe('hybridRetrieve end-to-end', () => {
  it('biases client docs and returns the merged top-N', async () => {
    fakeRetrieve.mockImplementation(async (ns: string) => {
      if (ns === GLOBAL_AAOIFI_NAMESPACE) return [makeDoc('g1'), makeDoc('g2')];
      return [makeDoc('c1'), makeDoc('c2')];
    });
    vi.mocked(getPineconeClient).mockReturnValue({
      inference: {
        rerank: vi.fn(async () => {
          throw new Error('no rerank');
        }),
      },
    } as never);

    const { ordered } = await hybridRetrieve({
      query: 'q',
      clientId: 'cz',
      kPerNamespace: 4,
      topN: 4,
    });

    // With fallback, client docs sort first thanks to the bias multiplier.
    expect(ordered[0]!.doc.__scope).toBe('client');
  });
});
