# src/agent — LangGraph workflow

The Sharia auditor's brain. A `StateGraph` compiled once with a MongoDB checkpointer, invoked per `/chat-audit` request. Powered by **OpenRouter** (`deepseek/deepseek-r1` for compliance reasoning + final report synthesis; `deepseek/deepseek-chat` for guardrail / clause parsing / CRAG evaluator / query rewriting / chat-Q&A) wired through `@langchain/openai`'s `ChatOpenAI` with `baseURL=https://openrouter.ai/api/v1`.

Two entry branches — picked by `routeOnEntry`:
- **Document attached (`audit`)** — Agentic CRAG: `parseClauses` → loop[ `retrieveForClause` → relevance evaluator → `reasoning` (+ autonomous `purification_calculator` tool when violationKind=riba) → `advanceClause` ] → `synthesizeReport` (the only node that streams `on_chat_model_stream` events for SSE `token` output).
- **No document (`chat`)** — `guardrail` → `retrieve` → `chatQa` (with Tavily web search tool) → `harvestWebSources`.

Greetings short-circuit to `greetingReply` for both branches.

## State (`state.ts`)

`AgentStateAnnotation` via `Annotation.Root({...})`. Channels:

| Channel | Reducer | Purpose |
|---|---|---|
| `messages` | `messagesStateReducer` (append) | Conversation history. Don't replace — append `HumanMessage` / `AIMessage` only. |
| `documentText` | replace | Uploaded doc text for this turn (replaced each call, not appended). |
| `context` | replace | Retrieved Pinecone chunks formatted for the prompt. |
| `sources` | replace | `RetrievedSource[]` returned to the client as citations. |
| `guardrailBlocked` | replace | Set by `guardrailNode` when intent is off-topic; routing reads it. |
| `contextSummary` | replace | Org-level context loaded from `organization.contextSummary`. |
| `clientId` | replace | Validated audited-client id for tenant-scoped retrieval. `null` = firm-wide chat. |
| `clauses` | replace | Output of Hierarchical Parsing Agent (Node A). |
| `currentClauseIndex` | replace | CRAG loop cursor across `clauses`. |
| `cragAttempts` | replace | Query-rewrite attempts for the current clause (cap 2). |
| `rewrittenQuery` | replace | Last rewritten query from the CRAG rewriter; `null` = use raw clause text. |
| `findings` | replace | Accumulating `ClauseFinding[]` from the reasoning node. |
| `purificationAmount` / `purificationDetails` | replace | Set when the purification calculator tool fires. |

Nodes return `Partial<AgentStateUpdate>` — never spread the full state.

## Graph (`graph.ts`)

Two compiled graphs:

- `getCompiledGraph()` — with `MongoDBSaver` checkpointer; per-`thread_id` memory persists. Used for normal chats.
- `getEphemeralGraph()` — no checkpointer; one-shot run with no state retained. Used when the client sends `isConfidential=true`.

Both are lazy singletons cached in module scope. First call compiles the workflow; subsequent calls return the cached graph.

## Nodes (`nodes.ts` + sibling files)

| Node | Role |
|---|---|
| `greetingReplyNode` (`greeting.ts`) | If the user's first message is a greeting and no document attached, reply with the canned greeting; skip retrieval/audit. |
| `guardrailNode` (`guardrail.ts`) | Classifies intent via `withStructuredOutput`. Off-topic → sets `guardrailBlocked=true`; routing short-circuits the audit. |
| `retrieveShariaRules` (`retrieval.ts`) | Pinecone retriever (k=4). Queries both global AAOIFI namespace and `client_tenant_:{clientId}` when `clientId` is set. Falls back to first 500 chars of `documentText` if no user message. |
| `chatQaNode` (nodes.ts) | Non-document chat path. DeepSeek-V3 + Tavily web search. Streams via `on_chat_model_stream`. |
| `parseClausesNode` (`hierarchical-parser.ts`) | **Node A**. DeepSeek-V3 + Zod structured output. Splits `documentText` into typed `Clause[]`. Falls back to a single "whole document" clause on parse failure. |
| `retrieveForClauseNode` (`crag-evaluator.ts`) | **Node B.1**. Per-clause `hybridRetrieve`; appends to `sources` (globally-unique citation ids). |
| `routeAfterRetrieve` (`crag-evaluator.ts`) | **Node B.2**. DeepSeek-V3 relevance evaluator → `'reasoning' \| 'rewrite' \| 'skip'`. Fail-open on evaluator error. |
| `rewriteQueryNode` (`crag-evaluator.ts`) | **Node B.3**. Paraphrases the clause into a retrieval-friendly query; increments `cragAttempts`. |
| `reasoningNode` (`sharia-reasoning.ts`) | **Node C**. DeepSeek-R1 + `FindingSchema` (Zod). Records `ClauseFinding`. For riba findings, autonomously extracts monetary params (DeepSeek-V3 structured output) and invokes the `purification_calculator` tool (Node D). |
| `skipClauseNode` / `advanceClauseNode` (`sharia-reasoning.ts`) | Loop control. `routeAfterAdvance` decides `next` vs `synthesize`. |
| `synthesizeReportNode` (`audit-report.ts`) | **Node E**. DeepSeek-R1 composes the final markdown report from accumulated findings — this is the node whose stream becomes the SSE `token` payload. |
| `formatSourcesFromCandidates` (`source-format.ts`) | Shared helper that builds `RetrievedSource[]` + a context block from ranked Pinecone candidates. Used by both the chat-path retriever and the CRAG retriever. |
| `routeOnEntry` / `routeAfter*` | Conditional edges. Inspect state and pick the next node. |

## Prompts (`prompt.ts`)

- `buildHalimSystemPrompt({ context, contextSummary, documentText })` — audit + purification.
- `buildGuardrailPrompt()` — intent classifier with structured output schema.
- Exports `RetrievedSource` type used by both ingestion metadata and the client response.

## Streaming

`/chat-audit/stream` uses `graph.streamEvents({...}, { version: 'v2' })` and forwards `on_chat_model_stream` chunks as SSE `token` events. Final `sources` come from `on_chain_end` events (confidential mode) or from `graph.getState()` (persisted mode).

## Hard rules

- **Don't change the embedder.** See `lib/CLAUDE.md` — Pinecone vectors must stay numerically compatible with the Python service.
- **Don't add LLM retries in nodes.** Quota/rate-limit errors must surface to the route so `middleware/error.ts` maps them to 429 with `Retry-After`. Retrying in-node blocks clients for minutes.
- **Always namespace `thread_id` at the route boundary** via `namespaceThreadId(orgId, userThreadId, clientId)`. Don't pass raw `thread_id` to the graph.
