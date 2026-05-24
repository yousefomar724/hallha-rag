# src/agent — LangGraph workflow

The Sharia auditor's brain. A `StateGraph` compiled once with a MongoDB checkpointer, invoked per `/chat-audit` request.

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
| `shariaAuditNode` | Calls the LLM (`getLlm()` → Gemini) with the system prompt from `prompt.ts` + retrieved `context` + `documentText`. Sets `sources`. |
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
