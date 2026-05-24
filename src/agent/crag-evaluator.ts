import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { parseUpstreamLlmError } from '../lib/llm-errors.js';
import { getChatLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { hybridRetrieve } from './retrieval.js';
import { formatSourcesFromCandidates } from './source-format.js';
import type { AgentState, AgentStateUpdate, Clause } from './state.js';

export const MAX_CRAG_ATTEMPTS = 2;

const RelevanceSchema = z.object({
  relevant: z
    .boolean()
    .describe(
      'True if the retrieved AAOIFI / standards excerpts substantively address the Sharia compliance of the given clause. False if they are off-topic, generic, or do not let us audit this clause.',
    ),
  reason: z.string().describe('Short justification (one sentence).'),
});

const EVALUATOR_SYSTEM = `You evaluate whether retrieved Sharia-standard excerpts are RELEVANT enough to audit the given clause.

Return relevant=true only if at least one excerpt directly bears on the clause's Sharia issue (e.g. clause discusses late-payment penalty AND excerpt covers riba-an-nasi'ah / penalty rules).
Return relevant=false if excerpts are off-topic, too generic, or only tangentially related.
Respond with only the structured fields requested.`;

const REWRITER_SYSTEM = `You rewrite a search query for a Sharia-compliance vector database (AAOIFI standards).

Given a contract clause and the fact that the prior query returned irrelevant results, produce a SINGLE improved retrieval query (1–2 short sentences) that:
- Names the underlying Sharia concept (e.g. riba an-nasi'ah, gharar fahish, tawarruq, musharaka profit-sharing).
- Drops legalese/boilerplate.
- Keeps the financial mechanism (late penalty, fixed return, asset guarantee, etc.).

Return ONLY the rewritten query as plain text — no quotes, no preface.`;

function currentClause(state: AgentState): Clause | null {
  return state.clauses[state.currentClauseIndex] ?? null;
}

/**
 * Node B.1 — Retrieve excerpts for the current clause from Pinecone
 * (global AAOIFI namespace + client_tenant_:{clientId}).
 *
 * Source ids are kept globally-unique across the loop by offsetting `startId`
 * with the count of sources already accumulated in state.
 */
export async function retrieveForClauseNode(state: AgentState): Promise<AgentStateUpdate> {
  const clause = currentClause(state);
  if (!clause) {
    return { context: '', sources: state.sources };
  }
  const query = state.rewrittenQuery?.trim() || clause.text;
  const { ordered } = await hybridRetrieve({
    query,
    clientId: state.clientId ?? null,
  });

  const startId = state.sources.length + 1;
  const { sources: newSources, context } = await formatSourcesFromCandidates(ordered, startId);

  return {
    context,
    sources: [...state.sources, ...newSources],
  };
}

/**
 * Conditional-edge function: classify retrieved context for the current clause
 * and pick the next node. Runs the evaluator LLM here so a single Node B.2
 * traversal yields a routing decision.
 */
export async function routeAfterRetrieve(
  state: AgentState,
): Promise<'reasoning' | 'rewrite' | 'skip'> {
  const clause = currentClause(state);
  if (!clause) return 'skip';
  if (!state.context.trim()) {
    return state.cragAttempts < MAX_CRAG_ATTEMPTS ? 'rewrite' : 'skip';
  }
  try {
    const llm = getChatLlm().withStructuredOutput(RelevanceSchema);
    const result = await llm.invoke([
      new SystemMessage(EVALUATOR_SYSTEM),
      new HumanMessage(
        `CLAUSE (${clause.kind}) — ${clause.title}:\n${clause.text}\n\nRETRIEVED EXCERPTS:\n${state.context}`,
      ),
    ]);
    const parsed = RelevanceSchema.parse(result);
    if (parsed.relevant) return 'reasoning';
    return state.cragAttempts < MAX_CRAG_ATTEMPTS ? 'rewrite' : 'skip';
  } catch (err) {
    const parsed = parseUpstreamLlmError(err);
    if (parsed.kind !== 'unknown') throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'CRAG relevance evaluator failed; proceeding to reasoning with current context',
    );
    // Fail-open: better to reason from possibly-noisy context than to skip the clause.
    return 'reasoning';
  }
}

/**
 * Node B.3 — Rewrite the query for re-retrieval. Increments cragAttempts.
 */
export async function rewriteQueryNode(state: AgentState): Promise<AgentStateUpdate> {
  const clause = currentClause(state);
  if (!clause) {
    return { cragAttempts: state.cragAttempts + 1 };
  }
  try {
    const llm = getChatLlm();
    const response = await llm.invoke([
      new SystemMessage(REWRITER_SYSTEM),
      new HumanMessage(
        `Original clause (${clause.kind}):\n${clause.text}\n\nPrior retrieval was irrelevant. Produce one improved query.`,
      ),
    ]);
    const raw = response.content;
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw
              .map((p) =>
                p && typeof p === 'object' && 'text' in p
                  ? String((p as { text?: unknown }).text ?? '')
                  : '',
              )
              .join('')
          : '';
    const rewritten = text.trim();
    return {
      rewrittenQuery: rewritten.length > 0 ? rewritten : clause.text,
      cragAttempts: state.cragAttempts + 1,
      sources: state.sources.slice(0, state.sourcesBeforeClause),
    };
  } catch (err) {
    const parsed = parseUpstreamLlmError(err);
    if (parsed.kind !== 'unknown') throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'CRAG query rewriter failed; reusing clause text',
    );
    return {
      rewrittenQuery: clause.text,
      cragAttempts: state.cragAttempts + 1,
      sources: state.sources.slice(0, state.sourcesBeforeClause),
    };
  }
}
