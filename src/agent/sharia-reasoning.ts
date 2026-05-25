import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { parseUpstreamLlmError } from '../lib/llm-errors.js';
import { getChatLlm, getReasoningLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { purificationCalculatorTool } from './tools.js';
import type { AgentState, AgentStateUpdate, Clause, ClauseFinding } from './state.js';

const VIOLATION_KIND_VALUES = [
  'riba',
  'gharar',
  'maysir',
  'prohibited_industry',
  'other',
  'none',
] as const;

const FindingSchema = z.object({
  isCompliant: z
    .boolean()
    .describe('True if the clause is Sharia-compliant given the cited AAOIFI standards.'),
  violationDetails: z
    .string()
    .describe(
      'One paragraph: name the Sharia issue (Riba / Gharar / Maysir / prohibited industry / other), severity, and a plain-language explanation of why. Empty string when isCompliant=true.',
    ),
  aaoifiStandard: z
    .string()
    .describe(
      'The AAOIFI standard NAME and NUMBER (e.g. "FAS 4 — Musharaka Financing"). If no cited source carries a standard number, return "Standard not identified in retrieved set" — never invent one.',
    ),
  pageReference: z
    .string()
    .describe(
      'Exact location in the cited source: "p.{N}, § {section}". Mirror "?" / "—" if missing in metadata.',
    ),
  violationKind: z
    .enum(VIOLATION_KIND_VALUES)
    .describe(
      'Primary violation category. Use "none" when isCompliant=true.',
    ),
  citedSourceIds: z
    .array(z.number().int().positive())
    .describe('Inline citation ids (e.g. [1], [2]) from RETRIEVED EXCERPTS that support this finding.'),
});

const REASONING_SYSTEM = `You are the core Sharia Compliance Reasoner for Halim.

Given ONE contract clause and a set of RETRIEVED AAOIFI / standards EXCERPTS, decide whether the clause is Sharia-compliant and produce structured output.

RULES
- Cite ONLY excerpts that actually appear in RETRIEVED EXCERPTS — never invent a standard number.
- For aaoifiStandard, use the "standard:" value shown in the excerpt header when available; otherwise return "Standard not identified in retrieved set".
- For pageReference, format EXACTLY: "p.{N}, § {section}". Mirror "?" and "—" when unknown.
- For violationKind, prefer the most specific category. Use "none" only if isCompliant=true.
- For citedSourceIds, list the inline [n] ids you relied on.

Respond with only the structured fields requested.`;

/**
 * Hard character caps for the reasoning prompt. The reasoning model is fed the
 * retrieved excerpts for one clause; capping these here keeps us under the
 * provider window and bounds output token cost too. ~4 chars ≈ 1 token, so:
 *  - 80 000 chars ≈ 20 000 tokens for excerpts
 *  - 4 000 chars  ≈ 1 000 tokens for the clause text
 */
const MAX_EXCERPT_CHARS = 80_000;
const MAX_CLAUSE_CHARS = 4_000;

function truncate(text: string, max: number, suffix: string): string {
  return text.length > max ? text.slice(0, max) + suffix : text;
}

const PURIFICATION_EXTRACTOR_SYSTEM = `Extract the monetary parameters needed to compute Sharia purification (التطهير) for a non-compliant interest / penalty clause.

If the clause has a fixed principal, an explicit annual rate (percent), and an elapsed time in days (or you can convert months/years to days), return them. Otherwise return all zeros — the calculator will be skipped.

Default the day-count method to simple_360 unless the clause specifies otherwise.

Respond with only the structured fields requested.`;

const PurificationParamsSchema = z.object({
  principal: z.number().nonnegative(),
  annualRatePct: z.number().nonnegative(),
  days: z.number().int().nonnegative(),
  method: z.enum(['simple_360', 'simple_365']).default('simple_360'),
});

function currentClause(state: AgentState): Clause | null {
  return state.clauses[state.currentClauseIndex] ?? null;
}

/**
 * Node C — Sharia Reasoning & Compliance.
 *
 * 1. Calls DeepSeek-R1 with structured output to produce a ClauseFinding.
 * 2. If the finding is Riba, autonomously invokes the purification calculator tool
 *    (Node D) by first extracting monetary parameters and then calling the tool's
 *    pure function — folds the resulting amount into the finding.
 */
export async function reasoningNode(state: AgentState): Promise<AgentStateUpdate> {
  const clause = currentClause(state);
  if (!clause) return {};

  let finding: ClauseFinding;
  try {
    const llm = getReasoningLlm().withStructuredOutput(FindingSchema);
    const clauseText = truncate(clause.text, MAX_CLAUSE_CHARS, '…[truncated]');
    const contextBlock = state.context
      ? truncate(
          state.context,
          MAX_EXCERPT_CHARS,
          '\n…[excerpts truncated to fit context window]',
        )
      : '(none — proceed cautiously)';
    const raw = await llm.invoke([
      new SystemMessage(REASONING_SYSTEM),
      new HumanMessage(
        `CLAUSE (${clause.kind}) — ${clause.title}:\n${clauseText}\n\nRETRIEVED EXCERPTS:\n${contextBlock}`,
      ),
    ]);
    const parsed = FindingSchema.parse(raw);
    finding = {
      clauseId: clause.id,
      isCompliant: parsed.isCompliant,
      violationDetails: parsed.violationDetails,
      aaoifiStandard: parsed.aaoifiStandard,
      pageReference: parsed.pageReference,
      violationKind: parsed.violationKind,
      citedSourceIds: parsed.citedSourceIds,
    };
  } catch (err) {
    const parsed = parseUpstreamLlmError(err);
    if (parsed.kind !== 'unknown') throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Reasoning node structured-output failed; recording inconclusive finding',
    );
    finding = {
      clauseId: clause.id,
      isCompliant: false,
      violationDetails:
        'Automated reasoning failed for this clause. A qualified scholar should review it manually.',
      aaoifiStandard: 'Standard not identified in retrieved set',
      pageReference: 'p.?, § —',
      violationKind: 'other',
      citedSourceIds: [],
    };
  }

  let purificationAmount: number | null = state.purificationAmount;
  let purificationDetails: string | null = state.purificationDetails;

  // Node D — Autonomous purification tool invocation for riba findings.
  if (finding.violationKind === 'riba' && !finding.isCompliant) {
    const tooled = await tryInvokePurification(clause);
    if (tooled) {
      finding.purification = { amount: tooled.amount, formula: tooled.formula };
      purificationAmount = (purificationAmount ?? 0) + tooled.amount;
      const line = `Clause ${clause.id} (${clause.title}): ${tooled.formula}`;
      purificationDetails = purificationDetails ? `${purificationDetails}\n${line}` : line;
    }
  }

  return {
    findings: [...state.findings, finding],
    purificationAmount,
    purificationDetails,
  };
}

async function tryInvokePurification(
  clause: Clause,
): Promise<{ amount: number; formula: string } | null> {
  try {
    const llm = getChatLlm().withStructuredOutput(PurificationParamsSchema);
    const clauseText = truncate(clause.text, MAX_CLAUSE_CHARS, '…[truncated]');
    const raw = await llm.invoke([
      new SystemMessage(PURIFICATION_EXTRACTOR_SYSTEM),
      new HumanMessage(`CLAUSE:\n${clauseText}`),
    ]);
    const params = PurificationParamsSchema.parse(raw);
    if (params.principal <= 0 || params.annualRatePct <= 0 || params.days <= 0) {
      return null;
    }
    const out = await purificationCalculatorTool.invoke(params);
    const parsed = JSON.parse(typeof out === 'string' ? out : String(out)) as {
      amount?: unknown;
      formula?: unknown;
    };
    const amount = typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount);
    const formula = typeof parsed.formula === 'string' ? parsed.formula : '';
    if (!Number.isFinite(amount) || amount <= 0 || !formula) return null;
    return { amount, formula };
  } catch (err) {
    const parsed = parseUpstreamLlmError(err);
    if (parsed.kind !== 'unknown') throw err;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Purification tool invocation failed; skipping for this clause',
    );
    return null;
  }
}

/**
 * Tiny advance/loop control node: bumps cursor to the next clause and resets
 * per-clause scratch (cragAttempts, rewrittenQuery, context). The router
 * `routeAfterAdvance` decides whether to loop or move to synthesis.
 */
export async function advanceClauseNode(state: AgentState): Promise<AgentStateUpdate> {
  return {
    currentClauseIndex: state.currentClauseIndex + 1,
    cragAttempts: 0,
    rewrittenQuery: null,
    context: '',
    sourcesBeforeClause: state.sources.length,
  };
}

export function routeAfterAdvance(state: AgentState): 'next' | 'synthesize' {
  return state.currentClauseIndex < state.clauses.length ? 'next' : 'synthesize';
}

/**
 * Skip-clause variant: when CRAG gives up after MAX_CRAG_ATTEMPTS with no
 * relevant context, record an inconclusive finding for this clause before
 * advancing.
 */
export async function skipClauseNode(state: AgentState): Promise<AgentStateUpdate> {
  const clause = currentClause(state);
  const skipFinding: ClauseFinding | null = clause
    ? {
        clauseId: clause.id,
        isCompliant: false,
        violationDetails:
          'No relevant AAOIFI standards were retrieved for this clause after multiple attempts. Manual review recommended.',
        aaoifiStandard: 'Standard not identified in retrieved set',
        pageReference: 'p.?, § —',
        violationKind: 'other',
        citedSourceIds: [],
      }
    : null;
  return {
    findings: skipFinding ? [...state.findings, skipFinding] : state.findings,
    currentClauseIndex: state.currentClauseIndex + 1,
    cragAttempts: 0,
    rewrittenQuery: null,
    context: '',
    sourcesBeforeClause: state.sources.length,
  };
}
