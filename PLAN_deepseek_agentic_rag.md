# Plan — Migrate to DeepSeek + Advanced Agentic RAG (CRAG) in LangGraph

## Context

The Sharia-auditing backend currently uses a single-shot LangGraph: greeting → guardrail → retrieve (Pinecone, global + client namespaces, with rerank) → audit (Gemini with Tavily tool) → harvest web sources → END. The LLM is Gemini via `@langchain/google-genai`; Groq is retained only for Whisper transcription.

This plan migrates LLM inference to **DeepSeek** (DeepSeek-R1 for reasoning, DeepSeek-V3 for fast routing) and rebuilds the document-upload path as an **Agentic Corrective RAG (CRAG)** flow with hierarchical clause parsing, evaluator-driven query rewriting, structured compliance reasoning, and an autonomous `PurificationCalculator` tool. The plain chat-Q&A path (no document attached) keeps the simpler retrieve→audit shape but on DeepSeek-V3, so existing chat behavior continues to work.

The SSE contract in `HALLHA_INTEGRATION.md` is **unchanged**: per-clause work happens server-side and only the final synthesized markdown report streams as `token` events. `sources`/`citations`/`done` semantics remain identical, so the Next.js frontend needs no changes.

## Hard constraints (do not violate)

- **Do not touch `src/lib/embeddings.ts`** — Pinecone vectors are shared with a Python service (parity-locked).
- **Do not rename Mongo checkpoint collections** (`checkpoints_langgraph_js`, `checkpoint_writes_langgraph_js`).
- **ESM + NodeNext**: every relative import ends in `.js`.
- **`noUncheckedIndexedAccess` is on** — guard array indexing.
- **Throw `HttpError`/upstream errors; never write status codes** in nodes/routes.
- **No in-node LLM retries** — quota/429 must surface so `middleware/error.ts` returns 429+`Retry-After`. Add `'deepseek'` as a recognized provider in `llm-errors.ts`.
- **SSE contract frozen** — token/sources/citations/done payload shapes per `HALLHA_INTEGRATION.md`.

## Files to modify

### Env + provider wiring

- **`src/config/env.ts`** — add `DEEPSEEK_API_KEY: z.string().min(1)`, plus optional `DEEPSEEK_REASONING_MODEL` (default `'deepseek-reasoner'`) and `DEEPSEEK_CHAT_MODEL` (default `'deepseek-chat'`). Keep `GOOGLE_API_KEY` / `GEMINI_*` as **optional** to avoid breaking dev envs that still have them set, but they become unused at runtime.
- **`src/lib/llm.ts`** — replace Gemini singletons with two DeepSeek singletons using `ChatOpenAI` from `@langchain/openai`:
  - `getReasoningLlm()` → `ChatOpenAI({ apiKey: env.DEEPSEEK_API_KEY, model: env.DEEPSEEK_REASONING_MODEL, configuration: { baseURL: 'https://api.deepseek.com' }, temperature: 0 })`
  - `getChatLlm()` → same factory with `DEEPSEEK_CHAT_MODEL`, used for guardrail, clause parsing, CRAG evaluator, query rewriting, and the non-document chat path.
  - `getLlmWithTools()` becomes `getReasoningLlmWithTools()` and binds both `webSearchTool` (existing) **and** the new `purificationCalculatorTool`.
  - Keep call sites stable by re-exporting `getLlm = getReasoningLlm` and `getGuardrailLlm = getChatLlm` so `guardrail.ts` and other consumers compile unchanged on day one; remove the aliases in a follow-up pass.
- **`src/lib/llm-errors.ts`** — extend `parseUpstreamLlmError` to recognize DeepSeek/OpenAI-shaped errors: HTTP 429, `code: 'rate_limit_exceeded'`, `insufficient_quota`, etc. Set `provider: 'deepseek'`. Update the error-mapper provider union in `middleware/error.ts` accordingly.
- **`package.json`** — add `@langchain/openai` (peer-compatible with existing `@langchain/core` major). Run `pnpm install` after.

### Agent state

- **`src/agent/state.ts`** — add channels needed by the CRAG loop. All `replace`-reducer:
  - `clauses: Clause[]` — output of Hierarchical Parsing Agent.
  - `currentClauseIndex: number` — loop cursor.
  - `cragAttempts: number` — guard against infinite query-rewriting (cap at 2).
  - `rewrittenQuery: string | null` — last rewritten query for the current clause.
  - `findings: ClauseFinding[]` — accumulating structured outputs from the reasoning node.
  - `purificationAmount: number | null` and `purificationDetails: string | null` — set by the tool when invoked.
  - Type `Clause = { id: string; kind: 'penalty' | 'profit_sharing' | 'guarantee' | 'pricing' | 'governance' | 'other'; title: string; text: string }`.
  - Type `ClauseFinding` mirrors the Zod schema in Node C below.

### New / refactored nodes (`src/agent/`)

Put each node in its own file for testability, mirroring the existing `guardrail.ts` / `greeting.ts` / `retrieval.ts` pattern:

- **`src/agent/hierarchical-parser.ts`** (Node A) — `parseClausesNode`. Uses `getChatLlm().withStructuredOutput(ClausesSchema)` (Zod) on `state.documentText` to emit `Clause[]`. Schema requires an enum `kind` and a verbatim `text` span. Sets `clauses`, resets `currentClauseIndex=0`, `findings=[]`, `cragAttempts=0`.

- **`src/agent/crag-evaluator.ts`** (Node B) — two functions:
  1. `retrieveForClauseNode` — calls existing `hybridRetrieve({ query: rewrittenQuery ?? currentClause.text, clientId })` from `src/agent/retrieval.ts`. Writes `context` + `sources` (extends, not replaces, accumulating across clauses; see synthesis below). Reuse the source-formatting block currently in `retrieveShariaRules` — extract it into an exported helper `formatSourcesFromCandidates(ordered, clientDisplay, globalDisplay)` so both the legacy chat path and CRAG share it.
  2. `evaluateRelevanceNode` — `getChatLlm().withStructuredOutput(z.object({ relevant: z.boolean(), reason: z.string() }))`. Prompted with the clause text + retrieved excerpts. Returns `'reasoning' | 'rewrite' | 'skip'`:
     - `relevant` → `'reasoning'`
     - `!relevant && cragAttempts < 2` → `'rewrite'`
     - otherwise → `'skip'` (record an empty/uncertain finding and move on; never loop forever).
  3. `rewriteQueryNode` — `getChatLlm()` produces a more retrieval-friendly paraphrase of the clause; increments `cragAttempts`; sets `rewrittenQuery`.

- **`src/agent/sharia-reasoning.ts`** (Node C) — `reasoningNode`. Uses `getReasoningLlm().withStructuredOutput(FindingSchema)` where `FindingSchema = z.object({ clauseId: z.string(), isCompliant: z.boolean(), violationDetails: z.string(), aaoifiStandard: z.string(), pageReference: z.string(), violationKind: z.enum(['riba','gharar','maysir','prohibited_industry','other','none']) })`. `pageReference` comes from the cited source's Pinecone metadata (`page`, `headings`, `standardNumber`). Appends to `state.findings`. If `violationKind === 'riba'` and the clause text includes monetary fields (rate/principal/term), the reasoning prompt is instructed to emit a `tool_calls` for `purification_calculator` — the agent will autonomously invoke Node D.

- **`src/agent/tools.ts`** — add `purificationCalculatorTool` (`DynamicStructuredTool`):
  ```ts
  schema: z.object({
    principal: z.number(),
    annualRatePct: z.number(),
    days: z.number().int().nonnegative(),
    method: z.enum(['simple_360','simple_365']).default('simple_360'),
  })
  func: returns JSON.stringify({ amount, formula, currencyHint: 'unspecified' })
  ```
  Pure arithmetic; no I/O. Export `WEB_SEARCH_TOOL_MESSAGE_NAME` unchanged. Add `PURIFICATION_TOOL_NAME = 'purification_calculator'` and update `agentTools` to include both.

- **`src/agent/synthesis.ts`** (already exists — repurpose/replace) — `synthesizeReportNode` (Node E, terminal for the doc path). Uses `getReasoningLlm()` to compose the final markdown audit report from `state.findings`, `state.purificationAmount`, and `state.contextSummary`, in the exact 5-field structure already specified by `buildHalimSystemPrompt` (Executive Summary → Identified Compliance Risks → optional Cross-cutting Amendments). **This is the node whose `on_chat_model_stream` events become the SSE `token` payloads** — preserves the frontend contract.

- **`src/agent/nodes.ts`** — keep `greetingReplyNode`, `guardrailNode`, `routeOnEntry`, `routeAfterGuardrail`. Replace `shariaAuditNode` with two variants used by different branches:
  - `chatQaNode` (no document) — DeepSeek-V3 with the existing `buildHalimSystemPrompt` against `state.context`, retains Tavily tool binding for chat-only web search. This is the streamed node on the non-doc branch.
  - The new doc branch routes through Nodes A→B→C→(D?)→E above and **does not** call `shariaAuditNode`.

### Graph wiring (`src/agent/graph.ts`)

```
START
 └─ routeOnEntry ── greeting ──► greetingReply ──► END
                  ├─ chat ─────► guardrail ──► retrieve ──► chatQa ──► harvestWebSources ──► END
                  └─ audit ────► parseClauses ──► retrieveForClause ──► evaluateRelevance
                                                                          ├─ reasoning ──► (toolNode? loops back to reasoning) ──► nextClauseOrSynthesize
                                                                          ├─ rewrite ───► retrieveForClause   (loop, cap 2)
                                                                          └─ skip ──────► nextClauseOrSynthesize
                                  nextClauseOrSynthesize:
                                    if currentClauseIndex+1 < clauses.length → bump index, reset cragAttempts/rewrittenQuery → retrieveForClause
                                    else → synthesizeReport ──► END
```

- Update `routeOnEntry` so a non-empty `documentText` routes to `'audit'` (existing) which now means the new parse-clauses entry, and empty document routes to `'chat'` (new) which preserves the existing guardrail/retrieve/audit chat path.
- Use `addConditionalEdges` for `evaluateRelevance` and for `nextClauseOrSynthesize` (implemented as a tiny pass-through node returning `{}` plus a router function).
- The `ToolNode` (`new ToolNode([...agentTools])`) is reachable from both `chatQa` (web search) and `reasoning` (purification calculator) — simpler is two separate `ToolNode` instances (`webSearchTools` after `chatQa`, `purificationTools` after `reasoning`) since the toolsets don't overlap functionally.
- Keep both `getCompiledGraph()` (with `MongoDBSaver`) and `getEphemeralGraph()` exports — the streaming route and confidential mode depend on them.

### Route (`src/routes/chat-audit.ts`)

- No contract change. Stream `synthesizeReport` for the doc branch and `chatQa` for the chat branch — both emit `on_chat_model_stream` events that the existing SSE forwarder already handles.
- After `done`, `sources` come from `graph.getState()` exactly as today; the new `formatSourcesFromCandidates` helper guarantees the citation list spans all clauses' retrieved docs.

### Tests (`tests/`)

- New: `tests/agent-crag.test.ts` — mock `getChatLlm` / `getReasoningLlm` / `hybridRetrieve` at the module boundary (pattern: `vi.mock('../src/lib/llm.js', ...)`); verify (a) parser produces N clauses → N retrieve cycles; (b) irrelevant evaluation triggers a rewrite then re-retrieve, capped at 2; (c) riba finding triggers `purification_calculator` tool call and amount is folded into the final report; (d) final SSE `token` stream comes only from `synthesizeReport`.
- Update `tests/chat-audit.test.ts` mocks: swap `@langchain/google-genai` mock for `@langchain/openai` `ChatOpenAI`.
- Add `tests/llm-errors.test.ts` cases for DeepSeek 429 / quota shapes.

### Docs

- **`CLAUDE.md`**, **`src/agent/CLAUDE.md`**, **`src/lib/CLAUDE.md`** — update the "uses Gemini" lines to "uses DeepSeek (R1 reasoning + V3 chat)" and document the new CRAG node graph + state channels. Keep Groq-for-Whisper note. The `HALLHA_INTEGRATION.md` error-table row "provider: gemini|groq" becomes "deepseek|groq".

## Reused existing utilities (do not reinvent)

- `src/agent/retrieval.ts` — `hybridRetrieve`, `retrieveAcrossNamespaces`, `applyClientBias`, `rerankDocuments`. Node B calls these directly.
- `src/lib/pinecone.ts` — `GLOBAL_AAOIFI_NAMESPACE`, `clientTenantNamespace`, `getRetrieverForNamespace`.
- `src/lib/knowledge-files.ts` + `src/agent/retrieval-display-names.ts` — display-name resolution for citations.
- `src/utils/standard-number.ts` — `extractStandardNumber` for `pageReference` enrichment.
- `src/agent/prompt.ts` — `buildHalimSystemPrompt` + `RetrievedSource` type; reuse for the chat branch and for the final synthesis prompt body.
- `src/agent/greeting.ts`, `src/agent/guardrail.ts`, `src/agent/audit-defaults.ts` — untouched.

## Verification

1. `pnpm typecheck` — must pass (especially CRAG state types and Zod inference).
2. `pnpm test` — full Vitest suite green, including the new `agent-crag.test.ts`.
3. `pnpm dev` (port 8000) + frontend `npm run dev` (port 3000):
   - **Chat-only flow** (no doc): send a Sharia question → expect tokens stream, `sources` populated, behavior matches pre-migration.
   - **Document audit flow**: upload a sample contract with multiple clauses (penalty, profit-sharing, guarantee) → expect (a) only the final report streams via `token` events; (b) `sources` returned include hits for each clause; (c) the report has the 5-field per-risk structure; (d) at least one riba clause causes a Purification (التطهير) amount to appear, computed by the tool.
   - **Confidential flow** (`isConfidential=true`): ephemeral graph runs end-to-end, no Mongo checkpoint row written.
   - **429 surfacing**: temporarily point DEEPSEEK to a bogus quota to confirm the error mapper returns 429 with `provider: 'deepseek'` and `Retry-After` (don't retry in-node).
4. Cross-check `HALLHA_INTEGRATION.md` — frontend `lib/api/sse.ts` parser unchanged; `RetrievedSource` shape unchanged; no frontend edits required.
