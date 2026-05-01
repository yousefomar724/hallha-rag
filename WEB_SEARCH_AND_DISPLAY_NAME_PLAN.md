# Plan — Tavily web search + knowledge-file display names

## Context

Two tightly-related upgrades to the Sharia-audit RAG stack:

1. **Web search via Tavily.** Today the agent only retrieves from Pinecone (4 chunks). When the indexed standards don't cover the user's question, Halim has to refuse or guess. Wiring Tavily as an LLM-callable tool gives the model an escape hatch for current/uncovered topics and surfaces real source URLs in citations.
2. **Knowledge-file display names.** Today the chat citations show the raw upload filename (e.g. `aaoifi-shariah-standards-2024-en.pdf`). Admins want a clean human label (e.g. "AAOIFI Shariah Standards 2024 (EN)"). This must round-trip from the upload form → Pinecone retrieval → chat-audit response → frontend chat page (`E:\client-projects\hallha-front-end`).

The `TAVILY_API_KEY` is already added to `.env` / `.env.example`. Decisions confirmed:

- Web search arch: **LLM tool-calling loop** (bind tools, ToolNode, conditional edge).
- Display name storage: **new Mongo `knowledge_files` collection** as single source of truth.
- Display name UX: **optional at upload, falls back to filename, not editable yet** (re-upload to change).
- Web citations: **merged into the existing `sources` list** with a `type: 'web' | 'document'` discriminator.

---

## Part 1 — Tavily web search (LLM tool-calling)

### 1.1 Dependencies & env

- `pnpm add @langchain/community` (provides `TavilySearchResults`).
- `src/config/env.ts` — add `TAVILY_API_KEY: z.string().min(1)` to the schema (required, since the bound tool must work).

### 1.2 New file: `src/agent/tools.ts`

Export a single Tavily tool instance and a typed wrapper that the agent can call. Use `TavilySearchResults` from `@langchain/community/tools/tavily_search` with `maxResults: 4`. Configure it to return JSON (`{ url, title, content, score }[]`) so we can parse results back into `RetrievedSource` rows.

```ts
import { TavilySearchResults } from '@langchain/community/tools/tavily_search';
import { env } from '../config/env.js';

export const webSearchTool = new TavilySearchResults({
  apiKey: env.TAVILY_API_KEY,
  maxResults: 4,
  // returns a JSON-encoded string of results — we parse it back in the audit node
});

export const agentTools = [webSearchTool] as const;
```

### 1.3 Bind tools to the LLM (`src/lib/llm.ts`)

The current singleton returns a bare `ChatGroq`. We need:

- `getLlm()` — bare model, kept for any non-tool callers.
- `getLlmWithTools()` — `getLlm().bindTools(agentTools)` — used by the audit node.

Keeping both avoids accidentally binding tools to greeting/title-generation paths that don't need them.

### 1.4 Update the agent graph (`src/agent/graph.ts`)

Add a `ToolNode` and a conditional edge so audit can loop through tool calls:

```
START → routeOnEntry → {greetingReply | retrieve}
retrieve → audit
audit → routeAfterAudit → {tools | END}
tools → audit   (loop until LLM returns no tool_calls)
greetingReply → END
```

- Import `ToolNode` from `@langchain/langgraph/prebuilt`.
- Add node `tools = new ToolNode(agentTools)`.
- Add `routeAfterAudit(state)` returning `'tools'` if the last `AIMessage` has non-empty `tool_calls`, else `END`.
- Replace `.addEdge('audit', END)` with `.addConditionalEdges('audit', routeAfterAudit, { tools: 'tools', [END]: END })` and add `.addEdge('tools', 'audit')`.

### 1.5 Audit node changes (`src/agent/nodes.ts`)

- Switch `getLlm()` → `getLlmWithTools()` inside `shariaAuditNode`.
- `state.messages` already accumulates via `messagesStateReducer`, so no extra wiring needed for ToolMessage history.
- Keep the quota-error mapping intact.

### 1.6 Folding web results into `state.sources`

After the audit loop terminates (i.e. after the conditional edge falls through to END), we need web results visible to the frontend. Two-step approach:

- **Add a small `harvestWebSources` post-step**: a tiny node inserted between `audit → END` (or fold into the conditional). It walks `state.messages` for any `ToolMessage` whose `name === 'tavily_search_results_json'`, parses the JSON, and appends entries to `state.sources` with:
  ```ts
  { id: nextId, type: 'web', source: title || domain, page: 0, url }
  ```
- Update `RetrievedSource` (`src/agent/prompt.ts`) to include `type: 'document' | 'web'` (default `'document'` for back-compat).
- Renumber `id` so document sources are `[1..n]` and web sources continue from `n+1`. The audit LLM already cites by `[id]` markers; the system prompt tells it that document IDs come first and any newly-fetched web pages will be assigned the next IDs after tool calls return.
- The graph becomes: `audit → routeAfterAudit → {tools | harvestWebSources} → END`.

### 1.7 System prompt update (`src/agent/prompt.ts`)

Add a short section to `buildHalimSystemPrompt` telling Halim:
- A `web_search` tool is available.
- **When to use it**: only when RETRIEVED KNOWLEDGE doesn't cover the user's question, or when the user explicitly asks for current/external information.
- **When not to use it**: for document audits, prefer AAOIFI-grounded retrieval; only search the web for sourced background context.
- After tool results return, cite them by `[id]` exactly like document sources — the host app will mark them as web sources separately.

### 1.8 SSE streaming (`src/routes/chat-audit.ts`)

`graph.streamEvents(... v2)` already emits `on_chat_model_stream` for every LLM invocation, including the post-tool-call one. Two adjustments:

- The first audit LLM pass may emit empty `text` chunks while it's planning a tool call (Groq returns content in `tool_call_chunks`, not `content`). The current filter `if (text.length > 0)` already handles this — verify in dev that nothing weird leaks.
- After the loop, the existing block that reads `finalState.values.sources` will now include the harvested web sources.
- Optionally emit a `tool_status` SSE event when a tool call starts (e.g. `event: tool_status, data: { name: 'web_search', status: 'running' }`) — nice UX hint but **out of scope** unless the frontend wants it.

### 1.9 Tests

- `tests/web-search.test.ts` (new) — mock `getLlmWithTools` to return an `AIMessage` with a `tool_calls` array on the first turn and a plain answer on the second; mock `TavilySearchResults.invoke` to return canned JSON. Assert:
  - The graph loops once, calls the tool, and returns a final answer.
  - `state.sources` contains both document and web entries with correct `type` and `id` ordering.
  - The chat-audit JSON response surfaces them.
- Existing `tests/chat-audit.test.ts` — verify it still passes (no tool calls path — assert backward compat).

---

## Part 2 — Knowledge-file display names

### 2.1 Mongo collection: `knowledge_files`

New file: `src/lib/knowledge-files.ts`. Lazy-init pattern matching `src/lib/chat-history.ts`.

Document shape:
```ts
type KnowledgeFileDoc = {
  s3Key: string;            // unique index
  organizationId: string;   // index for listing
  originalName: string;     // e.g. 'aaoifi-2024.pdf'
  displayName: string;      // user-provided OR fallback to originalName
  uploadedAt: Date;
  uploadedBy: string;       // userId
  sizeBytes: number;        // denormalized from req.file.size
};
```

Indexes: `{ s3Key: 1 }` unique, `{ organizationId: 1, uploadedAt: -1 }` for listing.

Functions to export:
- `recordKnowledgeFile(doc)` — insert (called from upload route).
- `getDisplayNamesForS3Keys(keys: string[]): Promise<Map<string, string>>` — batched lookup used by the retrieve node.
- `listKnowledgeFilesForOrg(orgId)` — used by the admin listing endpoint.
- `deleteKnowledgeFileBySi3Key(s3Key)` — called from the delete endpoint after S3/Pinecone cleanup.

### 2.2 Upload route (`src/routes/upload-knowledge.ts`)

Accept an optional `displayName` form field alongside `file`:

```ts
const rawDisplayName = typeof req.body?.displayName === 'string'
  ? req.body.displayName.trim()
  : '';
const displayName = rawDisplayName || req.file.originalname;
```

After successful S3 + Pinecone ingest, call `recordKnowledgeFile({ s3Key: key, organizationId, originalName, displayName, uploadedAt: new Date(), uploadedBy: req.user!.id, sizeBytes: req.file.size })`.

If the Mongo write fails, log it but **don't roll back** the S3+Pinecone work (admin can re-upload to refresh the doc). Keep response shape `{ status, message, source: { name, displayName, key, url } }` — adding `displayName` is additive, frontend can ignore it.

### 2.3 Retrieve node (`src/agent/nodes.ts`)

In `retrieveShariaRules`, after building the initial `sources` array from Pinecone metadata, look up display names by `s3Key` in one batched call:

```ts
const s3Keys = docs
  .map((d) => (d.metadata as any)?.s3Key)
  .filter((k): k is string => typeof k === 'string' && k.length > 0);
const displayNameByKey = await getDisplayNamesForS3Keys(s3Keys);

// then in the .map, add:
const s3Key = ... ;
const displayName = (s3Key && displayNameByKey.get(s3Key)) || source;
return { id, source, displayName, page, ... };
```

Also surface `s3Key` into the `RetrievedSource` Pinecone metadata read so the lookup can find it. Update `formatSourcesHint` (`src/agent/prompt.ts`) and the `context` formatter to use `displayName` instead of `source` for human-facing labels — the LLM should see and cite the display name, not the raw filename.

### 2.4 `RetrievedSource` type extension (`src/agent/prompt.ts`)

```ts
export type RetrievedSource = {
  id: number;
  type: 'document' | 'web';   // (from Part 1) — default 'document'
  source: string;             // raw filename, kept for back-compat
  displayName: string;        // human-facing label
  page: number;
  url?: string;
  headings?: string;
};
```

### 2.5 List/delete endpoints (admin route)

Identify the existing `GET /admin/knowledge-files` and `DELETE /admin/knowledge-files/:key` (per `src/routes/admin.ts`, recent commits added these). Update them to:

- **List**: read from the Mongo collection scoped to `organizationId`. Each item now has `{ key, name (originalName), displayName, size, lastModified, url }`. Keep S3 as the file store but Mongo as the metadata source — or keep S3 listObjects for `lastModified` and join Mongo for `displayName` (cleaner if the collection might lag for any reason).
- **Delete**: after S3 + Pinecone cleanup, call `deleteKnowledgeFileBySi3Key(key)`.

### 2.6 Backfill script (one-time)

`scripts/backfill-knowledge-files.ts`: scan all S3 keys under `knowledge/<orgId>/`, for each one insert a `knowledge_files` doc with `displayName = displayNameFromObjectKey(key)` (the existing helper in `src/lib/s3.ts`) if no doc exists. Idempotent. Add a pnpm script: `pnpm backfill:knowledge-files`.

This guarantees existing pre-feature uploads still surface `displayName` in chat citations (falling back to filename, which is the current behavior anyway).

### 2.7 Tests

- `tests/knowledge-files.test.ts` — mock Mongo and S3, assert upload writes the doc, list returns it, delete removes it.
- Update `tests/chat-audit.test.ts` so the retrieve mock includes a `displayName` and assert it lands in the `sources` response.

---

## Part 3 — Admin SPA frontend

### 3.1 Upload form: add display name field (`admin/src/pages/KnowledgePage.tsx`)

Add a labeled text input above the dropzone:

```tsx
<Input
  placeholder="Display name (optional, e.g. AAOIFI Shariah Standards 2024)"
  value={displayName}
  onChange={(e) => setDisplayName(e.target.value)}
  disabled={busy}
/>
```

State: `const [displayName, setDisplayName] = useState('')`. Pass it into `api.uploadKnowledge(file, displayName, onProgress)`.

### 3.2 API client (`admin/src/lib/api.ts`)

Update `uploadKnowledge` to accept `displayName?: string` and append it to the `FormData`:

```ts
const fd = new FormData();
fd.append('file', file);
if (displayName) fd.append('displayName', displayName);
```

### 3.3 File listing table

The `Name` column should show `displayName` (with the original filename in muted text below it, optional). Update the `KnowledgeFile` type in `api.ts` to include `displayName: string`, and render `f.displayName` in the table cell. Keep `f.name` (originalName) as a tooltip/secondary label so the actual filename is still discoverable.

### 3.4 Reset on success

After a successful upload, clear the `displayName` input alongside the existing reset logic.

---

## Part 4 — Chat frontend (`E:\client-projects\hallha-front-end`)

### 4.1 Type extension (`/lib/types/retrieved-source.ts`)

```ts
export type RetrievedSource = {
  id: number
  type?: 'document' | 'web'   // optional for back-compat
  source: string
  displayName?: string        // optional — falls back to source
  page: number
  url?: string
}
```

### 4.2 Citation rendering (`/components/chat/chat-message-content.tsx`)

Change line 173-ish from:

```jsx
<a href={s.url}>{s.source}</a>
```

to:

```jsx
<a href={s.url}>{s.displayName || s.source}</a>
```

For web sources, render a small badge next to the link (e.g. `Web` chip, optional polish):

```jsx
{s.type === 'web' && <span className="...badge">Web</span>}
```

For web sources, drop the page suffix (web pages have no page number). Conditional:

```jsx
{s.type !== 'web' && <span> — {t('sourcePage', { page: s.page })}</span>}
```

### 4.3 i18n (if applicable)

If translations are managed centrally, add a `webBadge` key (e.g. "Web", "ويب") used by the badge. Otherwise inline.

### 4.4 No SSE changes needed

The existing `sources` event handler in `/lib/api/sse.ts` already passes the array through — adding fields is transparent.

---

## Critical files to modify

**Backend (`E:\client-projects\hallha-node`)**
- `src/config/env.ts` — add `TAVILY_API_KEY`.
- `src/lib/llm.ts` — add `getLlmWithTools()`.
- `src/lib/knowledge-files.ts` — **new** (Mongo accessor).
- `src/agent/tools.ts` — **new** (Tavily tool).
- `src/agent/state.ts` — no change (sources channel already in place).
- `src/agent/nodes.ts` — switch to `getLlmWithTools`, batched displayName lookup, add `harvestWebSourcesNode`.
- `src/agent/graph.ts` — add `tools` ToolNode, `harvestWebSources` node, conditional edge from audit.
- `src/agent/prompt.ts` — extend `RetrievedSource` (`type`, `displayName`), update `formatSourcesHint` + system prompt (web_search guidance, displayName usage).
- `src/routes/upload-knowledge.ts` — accept `displayName` form field, call `recordKnowledgeFile`.
- `src/routes/admin.ts` — list/delete read from Mongo collection.
- `src/routes/chat-audit.ts` — minor (verify SSE still clean with tool loop).
- `scripts/backfill-knowledge-files.ts` — **new**.
- `package.json` — add `@langchain/community`, `backfill:knowledge-files` script.
- `.env.example` — confirm `TAVILY_API_KEY=` line is present.
- `tests/web-search.test.ts` — **new**.
- `tests/knowledge-files.test.ts` — **new**.
- `tests/chat-audit.test.ts` — update for displayName.

**Admin SPA (`admin/`)**
- `admin/src/pages/KnowledgePage.tsx` — display-name input + show in table.
- `admin/src/lib/api.ts` — extend `uploadKnowledge` and `KnowledgeFile` type.

**Chat frontend (`E:\client-projects\hallha-front-end`)**
- `lib/types/retrieved-source.ts` — extend type.
- `components/chat/chat-message-content.tsx` — render `displayName || source`, web badge.

---

## Reused functions / utilities

- `src/lib/s3.ts::displayNameFromObjectKey` — reuse in the backfill script.
- `src/lib/mongo.ts` lazy-singleton pattern — mirror in `src/lib/knowledge-files.ts`.
- `src/lib/chat-history.ts` — reference for collection-init + index pattern.
- `messagesStateReducer` (already in `state.ts`) — handles ToolMessage append automatically; no change needed.

---

## Verification (end-to-end)

### Backend unit tests
```
pnpm test tests/web-search.test.ts
pnpm test tests/knowledge-files.test.ts
pnpm test tests/chat-audit.test.ts
pnpm typecheck
```

### Manual integration

1. **Tavily smoke test**: with `TAVILY_API_KEY` set, run `pnpm dev`, POST to `/chat-audit` with `thread_id=test-tavily` and a question outside the AAOIFI scope (e.g. "What did the SEC announce about crypto staking this week?"). Confirm:
   - Server logs show a tool call to `tavily_search_results_json`.
   - Response `sources` array contains entries with `type: 'web'` and `url` pointing to real pages.
   - Inline `[n]` markers in the response text reference those IDs.

2. **Display name round-trip**:
   - Run `pnpm dev:admin`, open `/knowledge`, upload a PDF with display name "Test AAOIFI Doc 2026".
   - Check Mongo: `db.knowledge_files.findOne({ displayName: 'Test AAOIFI Doc 2026' })` returns the doc.
   - Refresh listing — table shows "Test AAOIFI Doc 2026" in the Name column.
   - In the chat frontend, ask a question that should retrieve from this PDF. Citations should render as "Test AAOIFI Doc 2026 — p. N", not the raw `.pdf` filename.

3. **Backfill**: against an env with existing pre-feature uploads, run `pnpm backfill:knowledge-files` and confirm idempotency (re-running inserts zero new docs).

4. **SSE streaming**: in the frontend chat page, send a message that triggers a web-search tool call. Observe streamed tokens come through correctly (no garbled tool-call deltas leaking into visible text), and the final `sources` event contains both document and web sources.

5. **Backwards compat**: ask a question with no document and a topic fully covered by AAOIFI. Confirm the LLM does NOT call the tool (saves Tavily quota), and the existing document-citations flow is unchanged.

### Type-check both repos
```
# Backend
pnpm typecheck

# Chat frontend
cd E:\client-projects\hallha-front-end && pnpm typecheck   # (or equivalent)
```
