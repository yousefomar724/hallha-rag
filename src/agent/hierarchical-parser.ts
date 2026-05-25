import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { parseUpstreamLlmError } from '../lib/llm-errors.js';
import { getChatLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import type { AgentState, AgentStateUpdate, Clause, ClauseKind } from './state.js';

const CLAUSE_KIND_VALUES = [
  'penalty',
  'profit_sharing',
  'guarantee',
  'pricing',
  'governance',
  'other',
] as const;

const ClauseSchema = z.object({
  kind: z.enum(CLAUSE_KIND_VALUES).describe(
    'Type of financial clause. Use "other" if none of the named kinds fit.',
  ),
  title: z
    .string()
    .min(1)
    .describe(
      'Short human-facing label, e.g. "Late-payment penalty", "Profit-sharing ratio", "Performance guarantee".',
    ),
  text: z
    .string()
    .min(1)
    .describe(
      'Verbatim excerpt from the document covering this clause. May span multiple sentences. Do NOT paraphrase or summarize.',
    ),
});

const ClausesEnvelopeSchema = z.object({
  clauses: z
    .array(ClauseSchema)
    .min(0)
    .max(40)
    .describe(
      'All distinct financial clauses found in the document, in document order. Skip boilerplate (definitions, signatures, recitals).',
    ),
});

const PARSER_SYSTEM = `You segment a financial / legal document into discrete Sharia-relevant clauses for downstream compliance audit.

INSTRUCTIONS
- Read the full document text.
- Extract each clause that may have Sharia implications: interest / late-payment / penalty clauses, profit-sharing ratios, guarantees, pricing terms, governance / dispute clauses, asset-backing terms, etc.
- Use enum "kind" for each clause: penalty | profit_sharing | guarantee | pricing | governance | other.
- Quote the clause text VERBATIM in the "text" field (no paraphrase, no commentary, no ellipses inside the quote — copy the substantive sentences in full).
- Use a short descriptive "title" (3–8 words).
- Order clauses as they appear in the document.
- Skip pure boilerplate (definitions, recitals, signature blocks, addresses) UNLESS they contain a Sharia-relevant term.
- If the document contains NO Sharia-relevant financial clauses, return an empty array.

Return only the structured fields requested.`;

const FALLBACK_CLAUSE_TITLE = 'Whole document';

/**
 * Character caps for the parser prompt.
 * - 80 000 chars ≈ 20 000 tokens fits comfortably under the chat-model 32 k window
 *   alongside the system prompt + structured-output schema.
 * - 4 000 chars ≈ 1 000 tokens is the per-clause cap used by CRAG / reasoning;
 *   matching it here prevents a fallback "whole document" clause from later
 *   blowing up the Pinecone rerank query (1024 tokens per query+document pair).
 */
const MAX_DOCUMENT_CHARS = 80_000;
const MAX_FALLBACK_CLAUSE_CHARS = 4_000;

function truncate(text: string, max: number, suffix: string): string {
  return text.length > max ? text.slice(0, max) + suffix : text;
}

/**
 * Node A — Hierarchical Parsing Agent.
 *
 * Splits the uploaded contract into typed clauses that the CRAG loop can audit individually.
 * On parse failure or empty output, falls back to a single "whole document" clause so the
 * downstream loop still produces a finding rather than silently dropping the audit.
 */
export async function parseClausesNode(state: AgentState): Promise<AgentStateUpdate> {
  const docText = state.documentText.trim();
  if (!docText) {
    return {
      clauses: [],
      currentClauseIndex: 0,
      cragAttempts: 0,
      rewrittenQuery: null,
      findings: [],
      purificationAmount: null,
      purificationDetails: null,
    };
  }

  const fallbackClause = (kind: ClauseKind = 'other'): Clause => ({
    id: 'c1',
    kind,
    title: FALLBACK_CLAUSE_TITLE,
    text: truncate(docText, MAX_FALLBACK_CLAUSE_CHARS, '…[truncated]'),
  });

  const promptDocText = truncate(
    docText,
    MAX_DOCUMENT_CHARS,
    '\n…[document truncated to fit context window]',
  );

  let clauses: Clause[];
  try {
    const llm = getChatLlm().withStructuredOutput(ClausesEnvelopeSchema);
    const result = await llm.invoke([
      new SystemMessage(PARSER_SYSTEM),
      new HumanMessage(`DOCUMENT:\n${promptDocText}`),
    ]);
    const parsed = ClausesEnvelopeSchema.parse(result);
    clauses = parsed.clauses.map((c, i) => ({
      id: `c${i + 1}`,
      kind: c.kind,
      title: c.title,
      text: c.text,
    }));
    if (clauses.length === 0) {
      logger.info('Hierarchical parser found no Sharia-relevant clauses; using fallback');
      clauses = [fallbackClause()];
    }
  } catch (err) {
    const parsed = parseUpstreamLlmError(err);
    if (parsed.kind !== 'unknown') throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Hierarchical parser failed; falling back to single-clause audit',
    );
    clauses = [fallbackClause()];
  }

  return {
    clauses,
    currentClauseIndex: 0,
    cragAttempts: 0,
    rewrittenQuery: null,
    findings: [],
    purificationAmount: null,
    purificationDetails: null,
    sources: [],
    context: '',
    sourcesBeforeClause: 0,
  };
}
