import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { RetrievedSource } from './prompt.js';

export type ClauseKind =
  | 'penalty'
  | 'profit_sharing'
  | 'guarantee'
  | 'pricing'
  | 'governance'
  | 'other';

export type Clause = {
  id: string;
  kind: ClauseKind;
  title: string;
  /** Verbatim excerpt from the uploaded document. */
  text: string;
};

export type ClauseFindingViolation =
  | 'riba'
  | 'gharar'
  | 'maysir'
  | 'prohibited_industry'
  | 'other'
  | 'none';

export type ClauseFinding = {
  clauseId: string;
  isCompliant: boolean;
  violationDetails: string;
  aaoifiStandard: string;
  pageReference: string;
  violationKind: ClauseFindingViolation;
  /** Subset of retrieved sources actually cited for this clause (by id). */
  citedSourceIds: number[];
  /** Optional purification line when Node D fired. */
  purification?: {
    amount: number;
    formula: string;
  };
};

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  documentText: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  context: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  sources: Annotation<RetrievedSource[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Set when guardrail refuses; reset to false on each HTTP invoke from chat-audit. */
  guardrailBlocked: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  /** Onboarding profile (org); injected from HTTP into every invoke. */
  contextSummary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** Audited-client id (firm's client). When set, retrieval queries both the global AAOIFI namespace and `client_tenant_:clientId`. */
  clientId: Annotation<string | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),

  // ---- CRAG / agentic audit channels ----

  /** Output of Node A (Hierarchical Parsing). One entry per logical financial clause. */
  clauses: Annotation<Clause[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Loop cursor across clauses. */
  currentClauseIndex: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /** Number of CRAG query-rewrite attempts for the current clause (cap 2). */
  cragAttempts: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /** Last rewritten query produced by Node B's rewriter; null = use the raw clause text. */
  rewrittenQuery: Annotation<string | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),
  /** Accumulating per-clause structured findings. Replaced (not appended via reducer) by Node C. */
  findings: Annotation<ClauseFinding[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Last purification calculator output captured by the audit loop. */
  purificationAmount: Annotation<number | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),
  purificationDetails: Annotation<string | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),
  /** Index into `sources` before the current clause's retrieval loop; used to trim stale citations on rewrite. */
  sourcesBeforeClause: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;
