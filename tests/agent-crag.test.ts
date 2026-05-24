import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemMessage } from '@langchain/core/messages';
import type { AgentState, Clause, ClauseFinding } from '../src/agent/state.js';
import type { RetrievedSource } from '../src/agent/prompt.js';

const chatInvokeMock = vi.hoisted(() => vi.fn());
const reasoningInvokeMock = vi.hoisted(() => vi.fn());
const hybridRetrieveMock = vi.hoisted(() => vi.fn());
const formatSourcesMock = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/llm.js', () => ({
  getChatLlm: vi.fn(() => ({
    withStructuredOutput: () => ({ invoke: chatInvokeMock }),
    invoke: chatInvokeMock,
  })),
  getReasoningLlm: vi.fn(() => ({
    withStructuredOutput: () => ({ invoke: reasoningInvokeMock }),
    invoke: reasoningInvokeMock,
  })),
}));

vi.mock('../src/agent/retrieval.js', () => ({
  hybridRetrieve: hybridRetrieveMock,
}));

vi.mock('../src/agent/source-format.js', () => ({
  formatSourcesFromCandidates: formatSourcesMock,
}));

const { parseClausesNode } = await import('../src/agent/hierarchical-parser.js');
const {
  retrieveForClauseNode,
  routeAfterRetrieve,
  rewriteQueryNode,
  MAX_CRAG_ATTEMPTS,
} = await import('../src/agent/crag-evaluator.js');
const {
  reasoningNode,
  advanceClauseNode,
  routeAfterAdvance,
} = await import('../src/agent/sharia-reasoning.js');
const { synthesizeReportNode } = await import('../src/agent/audit-report.js');

const QUOTA_ERR = new Error('429 You exceeded your current quota, code: insufficient_quota, api.deepseek.com');

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    documentText: '',
    context: '',
    sources: [],
    guardrailBlocked: false,
    contextSummary: '',
    clientId: null,
    clauses: [],
    currentClauseIndex: 0,
    cragAttempts: 0,
    rewrittenQuery: null,
    findings: [],
    purificationAmount: null,
    purificationDetails: null,
    sourcesBeforeClause: 0,
    ...overrides,
  };
}

const clauseA: Clause = {
  id: 'c1',
  kind: 'penalty',
  title: 'Late payment penalty',
  text: 'Borrower shall pay 12% per annum on overdue amounts.',
};

const clauseB: Clause = {
  id: 'c2',
  kind: 'profit_sharing',
  title: 'Profit sharing ratio',
  text: 'Profits shall be shared 70/30 between partners.',
};

function mockFinding(clauseId: string, compliant = true): ClauseFinding {
  return {
    clauseId,
    isCompliant: compliant,
    violationDetails: compliant ? '' : 'Late-payment penalty constitutes riba.',
    aaoifiStandard: 'FAS 4 — Musharaka Financing',
    pageReference: 'p.12, § 3.1',
    violationKind: compliant ? 'none' : 'riba',
    citedSourceIds: [1],
  };
}

describe('agentic CRAG loop', () => {
  beforeEach(() => {
    chatInvokeMock.mockReset();
    reasoningInvokeMock.mockReset();
    hybridRetrieveMock.mockReset();
    formatSourcesMock.mockReset();

    hybridRetrieveMock.mockResolvedValue({ ordered: [{ doc: { pageContent: 'excerpt' } }] });
    formatSourcesMock.mockImplementation(async (_ordered: unknown[], startId: number) => ({
      sources: [
        {
          id: startId,
          type: 'document' as const,
          source: 'aaoifi.pdf',
          displayName: 'AAOIFI Standards',
          page: 12,
        },
      ],
      context: `[${startId}] AAOIFI excerpt on penalties`,
    }));
  });

  it('parser produces N clauses and the loop accumulates N findings', async () => {
    chatInvokeMock.mockResolvedValueOnce({
      clauses: [
        { kind: 'penalty', title: clauseA.title, text: clauseA.text },
        { kind: 'profit_sharing', title: clauseB.title, text: clauseB.text },
      ],
    });
    reasoningInvokeMock
      .mockResolvedValueOnce({
        isCompliant: true,
        violationDetails: '',
        aaoifiStandard: 'FAS 4',
        pageReference: 'p.1, § 1',
        violationKind: 'none',
        citedSourceIds: [1],
      })
      .mockResolvedValueOnce({
        isCompliant: true,
        violationDetails: '',
        aaoifiStandard: 'FAS 4',
        pageReference: 'p.2, § 2',
        violationKind: 'none',
        citedSourceIds: [2],
      });

    chatInvokeMock.mockResolvedValue({ relevant: true, reason: 'On topic' });

    let state = baseState({ documentText: 'Full contract text with two clauses.' });
    const parsed = await parseClausesNode(state);
    state = { ...state, ...parsed };
    expect(state.clauses).toHaveLength(2);

    for (let i = 0; i < state.clauses.length; i++) {
      const retrieved = await retrieveForClauseNode(state);
      state = { ...state, ...retrieved };

      const route = await routeAfterRetrieve(state);
      expect(route).toBe('reasoning');

      const reasoned = await reasoningNode(state);
      state = { ...state, ...reasoned };

      const advanced = await advanceClauseNode(state);
      state = { ...state, ...advanced };
    }

    expect(state.findings).toHaveLength(2);
    expect(state.currentClauseIndex).toBe(2);
    expect(routeAfterAdvance(state)).toBe('synthesize');
  });

  it('caps CRAG rewrite attempts at MAX_CRAG_ATTEMPTS', async () => {
    chatInvokeMock.mockResolvedValue({ relevant: false, reason: 'Off topic' });

    const state = baseState({
      clauses: [clauseA],
      currentClauseIndex: 0,
      context: '[1] irrelevant excerpt',
      cragAttempts: 0,
    });

    expect(await routeAfterRetrieve(state)).toBe('rewrite');

    const afterOne = { ...state, cragAttempts: 1 };
    expect(await routeAfterRetrieve(afterOne)).toBe('rewrite');

    const afterTwo = { ...state, cragAttempts: MAX_CRAG_ATTEMPTS };
    expect(await routeAfterRetrieve(afterTwo)).toBe('skip');
  });

  it('truncates stale sources on rewrite', async () => {
    chatInvokeMock.mockResolvedValueOnce({ content: 'improved riba query' });

    const staleSources: RetrievedSource[] = [
      { id: 1, type: 'document', source: 'a.pdf', page: 1 },
      { id: 2, type: 'document', source: 'b.pdf', page: 2 },
    ];
    const state = baseState({
      clauses: [clauseA],
      sources: staleSources,
      sourcesBeforeClause: 0,
      cragAttempts: 0,
    });

    const update = await rewriteQueryNode(state);
    expect(update.sources).toEqual([]);
    expect(update.rewrittenQuery).toBeTruthy();
    expect(update.cragAttempts).toBe(1);
  });

  it('invokes purification calculator for riba findings', async () => {
    reasoningInvokeMock.mockResolvedValueOnce({
      isCompliant: false,
      violationDetails: 'Fixed penalty rate constitutes riba.',
      aaoifiStandard: 'FAS 4',
      pageReference: 'p.12, § 3.1',
      violationKind: 'riba',
      citedSourceIds: [1],
    });
    chatInvokeMock.mockResolvedValueOnce({
      principal: 10000,
      annualRatePct: 12,
      days: 30,
      method: 'simple_360',
    });

    const state = baseState({
      clauses: [clauseA],
      currentClauseIndex: 0,
      context: '[1] riba standard excerpt',
    });

    const update = await reasoningNode(state);
    expect(update.findings).toHaveLength(1);
    const finding = update.findings![0]!;
    expect(finding.purification).toBeDefined();
    expect(finding.purification!.amount).toBeGreaterThan(0);
    expect(update.purificationAmount).toBeGreaterThan(0);
  });

  it('re-throws upstream quota errors instead of falling back', async () => {
    chatInvokeMock.mockRejectedValueOnce(QUOTA_ERR);
    await expect(
      parseClausesNode(baseState({ documentText: 'contract text' })),
    ).rejects.toThrow(/insufficient_quota/);

    chatInvokeMock.mockRejectedValueOnce(QUOTA_ERR);
    await expect(
      routeAfterRetrieve(
        baseState({
          clauses: [clauseA],
          context: '[1] excerpt',
        }),
      ),
    ).rejects.toThrow(/insufficient_quota/);

    chatInvokeMock.mockRejectedValueOnce(QUOTA_ERR);
    await expect(
      rewriteQueryNode(baseState({ clauses: [clauseA], currentClauseIndex: 0 })),
    ).rejects.toThrow(/insufficient_quota/);

    reasoningInvokeMock.mockRejectedValueOnce(QUOTA_ERR);
    await expect(
      reasoningNode(
        baseState({
          clauses: [clauseA],
          currentClauseIndex: 0,
          context: '[1] excerpt',
        }),
      ),
    ).rejects.toThrow(/insufficient_quota/);
  });

  it('includes clause text in the synthesis prompt', async () => {
    reasoningInvokeMock.mockImplementation(async (messages: unknown[]) => {
      const sys = messages.find((m) => m instanceof SystemMessage);
      const text =
        sys && sys instanceof SystemMessage ? String(sys.content) : '';
      expect(text).toContain(clauseA.text);
      return { content: '# Audit Report\n\nExecutive Summary…' };
    });

    const state = baseState({
      clauses: [clauseA],
      findings: [mockFinding('c1', false)],
      sources: [
        {
          id: 1,
          type: 'document',
          source: 'aaoifi.pdf',
          displayName: 'AAOIFI Standards',
          page: 12,
          standardNumber: 'FAS 4',
        },
      ],
    });

    await synthesizeReportNode(state);
    expect(reasoningInvokeMock).toHaveBeenCalledOnce();
  });
});
