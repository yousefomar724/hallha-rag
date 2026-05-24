import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getReasoningLlm } from '../lib/llm.js';
import type { RetrievedSource } from './prompt.js';
import type { AgentState, AgentStateUpdate, ClauseFinding, Clause } from './state.js';

function formatSourcesHint(sources: RetrievedSource[]): string {
  if (sources.length === 0) return 'No sources retrieved.';
  return sources
    .map((s) => {
      const scopeTag =
        s.type === 'web'
          ? 'WEB'
          : s.scope === 'client'
            ? 'CLIENT DOCUMENT'
            : 'AAOIFI / GLOBAL';
      const std = s.standardNumber?.trim() || '—';
      const page =
        s.type === 'web' || !Number.isFinite(s.page) || s.page <= 0 ? '?' : String(s.page);
      const section = s.headings?.trim() || '—';
      const label = s.displayName?.trim() || s.source;
      return `[${s.id}] (${scopeTag}) ${label} — standard: ${std} — p.${page} — § ${section}`;
    })
    .join('\n');
}

function formatFindings(findings: ClauseFinding[], clauses: Clause[]): string {
  if (findings.length === 0) return '(no findings produced)';
  const byId = new Map(clauses.map((c) => [c.id, c]));
  return findings
    .map((f) => {
      const clause = byId.get(f.clauseId);
      const clauseText = clause?.text ?? '(clause text unavailable)';
      const truncated =
        clauseText.length > 800 ? `${clauseText.slice(0, 797)}…` : clauseText;
      const status = f.isCompliant ? 'COMPLIANT' : `NON-COMPLIANT (${f.violationKind})`;
      const cites = f.citedSourceIds.length ? `cited: [${f.citedSourceIds.join(', ')}]` : 'cited: []';
      const pur = f.purification
        ? `\n  purification: amount=${f.purification.amount}; formula=${f.purification.formula}`
        : '';
      return `- clauseId=${f.clauseId} status=${status}\n  clauseText: ${truncated}\n  standard: ${f.aaoifiStandard}\n  location: ${f.pageReference}\n  ${cites}\n  details: ${f.violationDetails}${pur}`;
    })
    .join('\n');
}

function buildReportSystemPrompt(args: {
  contextSummary?: string;
  sources: RetrievedSource[];
  findings: ClauseFinding[];
  clauses: Clause[];
  purificationDetails: string | null;
  purificationAmount: number | null;
}): string {
  const orgContextBlock =
    args.contextSummary?.trim() && args.contextSummary.trim().length > 0
      ? args.contextSummary.trim()
      : 'No organization onboarding context was provided.';
  const sourcesHint = formatSourcesHint(args.sources);
  const findingsBlock = formatFindings(args.findings, args.clauses);
  const purificationBlock =
    args.purificationAmount && args.purificationDetails
      ? `Total estimated purification across the document: ${args.purificationAmount}\nPer-clause:\n${args.purificationDetails}`
      : 'No purification amount was computed for this audit.';

  return `You are Halim (حليم), the AI co-auditor built into Hallha for Sharia audit firms.

You have ALREADY analysed an uploaded document clause-by-clause. STRUCTURED FINDINGS for each clause are provided below — your job is to synthesize them into the final audit report. Do not re-analyse; do not add new findings. Compose the markdown using ONLY the provided findings, sources, and contexts.

OUTPUT STRUCTURE (exact)
1. **Executive Summary** — 2–3 sentences: overall compliance posture and the single most material issue.
2. **Identified Compliance Risks** — For EACH non-compliant finding, use EXACTLY this five-field sub-structure (omit no field, use the exact bold labels):
   - **Quoted clause** — Quote the clause text verbatim from the \`clauseText\` field in STRUCTURED FINDINGS below. Append the relevant inline citation marker(s) like [n] using the citedSourceIds.
   - **Violation Description** — Repeat the structured finding's violationDetails, naming the Sharia issue (Riba / Gharar / Maysir / prohibited industry / other) and severity, plus a 1–2 sentence explanation.
   - **Standard Reference** — Use the structured finding's aaoifiStandard verbatim. Cite the source with its inline marker(s).
   - **Location** — Use the structured finding's pageReference verbatim.
   - **Solution / Purification (التطهير)** — A concrete sharia-compliant alternative. If the finding includes a purification amount/formula, also include a line beginning \`Purification (التطهير):\` with that formula.
3. **Cross-cutting Amendments** — Optional, only when amendments span multiple risks. Omit if not applicable.

If a finding has isCompliant=true, skip it (do not list compliant clauses).

CITATION RULES
- Use inline markers [n] from the AVAILABLE SOURCES table — every substantive claim must carry one when an excerpt supports it.
- Never cite a source id not in AVAILABLE SOURCES.
- Do NOT add a trailing "Sources" section — the host app renders sources separately.

LANGUAGE
- Respond in the same language as the underlying clauses / user context. Default to English if mixed.

BUSINESS / ORGANIZATION CONTEXT:
${orgContextBlock}

STRUCTURED FINDINGS (do not re-derive, just present):
${findingsBlock}

PURIFICATION SUMMARY:
${purificationBlock}

AVAILABLE SOURCES (citation markers):
${sourcesHint}`;
}

/**
 * Node E — Final report synthesis. Streamed via on_chat_model_stream → SSE `token`.
 */
export async function synthesizeReportNode(state: AgentState): Promise<AgentStateUpdate> {
  const llm = getReasoningLlm();
  const systemPrompt = buildReportSystemPrompt({
    contextSummary: state.contextSummary,
    sources: state.sources,
    findings: state.findings,
    clauses: state.clauses,
    purificationAmount: state.purificationAmount,
    purificationDetails: state.purificationDetails,
  });
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage('Produce the final audit report now.'),
  ]);
  return { messages: [response] };
}
