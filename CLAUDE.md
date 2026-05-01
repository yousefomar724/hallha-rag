# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (>=9), Node >=20. Workspace root is `pnpm-workspace.yaml` (packages: `.` + `admin`). All scripts auto-load `.env`.

- `pnpm dev` — watch-mode dev server via `tsx` (port 8000)
- `pnpm build` — `tsc` emit to `dist/`
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm start` — run built server from `dist/`
- `pnpm test` — Vitest run (single file: `pnpm test tests/chat-audit.test.ts`; single test: `pnpm test -t "rejects missing thread_id"`)
- `pnpm test:watch` — Vitest watch
- `pnpm lint` / `pnpm format` — ESLint / Prettier
- `pnpm dev:admin` — start admin SPA dev server (Vite, port 5173)
- `pnpm build:admin` — build admin SPA to `admin/dist/`
- `pnpm seed:admin` — seed the superadmin user (requires `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` in `.env`)

`vitest.config.ts` injects fake `GROQ_API_KEY`, `PINECONE_API_KEY`, `MONGO_URI` so tests don't need `.env` — but tests are expected to mock external services (see `tests/*.test.ts`), not hit them.

## Seeding

`scripts/seed-superadmin.ts` creates one superadmin user. Idempotent — safe to re-run.

```env
SEED_ADMIN_EMAIL=admin@hallha.com
SEED_ADMIN_PASSWORD=<strong-password>
```

Run with `pnpm seed:admin`. The user is created via Better-Auth's `signUpEmail` (which auto-creates an org), then patched to `role: 'superadmin', emailVerified: true`.

## Architecture

Express 5 + TypeScript port of a Python/FastAPI Sharia-compliance auditor. Two endpoints (`/upload-knowledge`, `/chat-audit`) sit in front of a LangGraph agent backed by Pinecone (RAG) and MongoDB (conversation memory).

### Request flow for `/chat-audit`

1. `routes/chat-audit.ts` — multer parses multipart (`memoryUpload`, in-memory buffer). PDFs are extracted via `unpdf` (`utils/pdf.ts`); other files are decoded as UTF-8. `thread_id` is required (422 if missing).
2. `agent/graph.ts::getCompiledGraph()` — lazily builds a `StateGraph` (`retrieve` → `audit`) compiled with a `MongoDBSaver` checkpointer. The compiled graph is cached in module scope.
3. `retrieveShariaRules` (`agent/nodes.ts`) — runs Pinecone retriever (k=4) against the last user message (or, if empty, the first 500 chars of the uploaded document). Returns `context`.
4. `shariaAuditNode` — calls the Groq LLM (`GROQ_MODEL`, default `llama-3.3-70b-versatile`) with a fixed system prompt embedding `state.context` + `state.documentText`. Quota / rate-limit errors are not retried — they map to HTTP 429 immediately so clients are not blocked for minutes.
5. Memory persists per `thread_id` via the checkpointer (`{ configurable: { thread_id } }`); `documentText` is replaced each call (not appended).

### Request flow for `/upload-knowledge`

`diskUpload` writes the PDF to `./uploads/<originalname>` → `rag/ingest.ts::ingestPdfToPinecone` converts the PDF to Markdown via `@opendocsg/pdf2md` (font-size heuristics → `#`/`##`/`###`), then splits on heading boundaries with `splitMarkdownByHeadings` (`utils/markdown-header-splitter.ts`). Sections that exceed 1800 chars fall back to `RecursiveCharacterTextSplitter` (1800/150). Each chunk carries a `headings` metadata field (e.g. `"Chapter II > Article 5 — Riba"`) for richer citations. Embeddings are upserted to Pinecone as before.

### Singletons / lifecycle

`lib/{embeddings,llm,mongo,pinecone}.ts` each export a lazy singleton. `src/index.ts` handles `SIGINT`/`SIGTERM` and calls `closeMongo()`. Tests import `createApp` from `src/app.ts` (no listener) so they can mock the graph or ingest module before app construction.

### State shape

`agent/state.ts` defines three channels via `Annotation.Root`: `messages` (uses `messagesStateReducer` so updates append), `documentText` (replace), `context` (replace). Always return partial `AgentStateUpdate`s from nodes.

## Cross-runtime parity (important)

- The Pinecone index is shared with the Python service. The custom `HuggingFaceTransformersEmbeddings` (`lib/embeddings.ts`) wraps `@huggingface/transformers` `Xenova/all-MiniLM-L6-v2` with mean-pooling + L2 normalize to match Python `sentence-transformers/all-MiniLM-L6-v2` (384-dim). **Do not change the model, pooling, or normalization** — vectors must stay numerically compatible with existing index data.
- **Node uses heading-aware chunking** via `@opendocsg/pdf2md` + a custom Markdown header splitter; the Python service still uses size-based 1800/150 splitting. Vector-level compatibility is preserved (same 384-dim embedder, same index), but the *shape* of retrieved chunks differs across runtimes — chunks ingested by Node carry a `headings` metadata field that Python-ingested chunks do not. Retriever k (4) and the audit system prompt still mirror the Python service. The Python stack uses Gemini; this Node stack uses Groq-hosted models (`GROQ_MODEL`) instead — behavior may differ slightly.
- **LangGraph Mongo checkpoints are NOT interchangeable between Python and JS.** The Python runtime stores checkpoints with `msgpack` serialization; this Node app uses LangGraph JS (`json`). If sharing a Mongo cluster with Python, give this service **distinct** checkpoint and checkpoint-writes collections (defaults `checkpoints_langgraph_js` and `checkpoint_writes_langgraph_js`).

## Configuration

`config/env.ts` validates env via Zod and `process.exit(1)`s on failure. Required: `GROQ_API_KEY`, `PINECONE_API_KEY`, `MONGO_URI`. Optional defaults: `GROQ_MODEL=llama-3.3-70b-versatile`, `PORT=8000`, `CORS_ORIGIN=*`, `PINECONE_INDEX=hallha`, `MONGO_DB_NAME=sharia_app`, `MONGO_CHECKPOINT_COLLECTION=checkpoints_langgraph_js`, `MONGO_CHECKPOINT_WRITES_COLLECTION=checkpoint_writes_langgraph_js`, `ADMIN_ORIGIN=http://localhost:5173`. Setting any `LANGSMITH_*` enables LangSmith auto-tracing. `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` are optional — only required when running `pnpm seed:admin`.

## Admin panel

`src/routes/admin.ts` exposes platform-management endpoints under `/admin/*`, all gated by `requireAdmin` (or `requireSuperadmin` for role/ban mutations):

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /admin/stats` | admin+ | Platform stats: users, orgs, plan distribution, audit totals, Pinecone chunk count |
| `GET /admin/organizations` | admin+ | Paginated org list with plan/usage |
| `GET /admin/organizations/:id` | admin+ | Org detail + member count + recent chats |
| `GET /admin/users` | admin+ | Paginated user list |
| `POST /admin/users/:id/role` | superadmin | Set user role via Better-Auth admin plugin |
| `POST /admin/users/:id/ban` | superadmin | Ban user |
| `POST /admin/users/:id/unban` | superadmin | Unban user |
| `POST /upload-knowledge` | admin+ | Ingest PDF to Pinecone (was plan-gated, now admin-only) |

### Roles

Better-Auth `admin` plugin (`src/lib/auth.ts`) adds `role` / `banned` fields to the `user` collection. Roles: `user` (default), `admin`, `superadmin`. The `requireAdmin` middleware (`src/middleware/require-admin.ts`) composes on top of `requireAuth`.

### Admin SPA (`admin/`)

Vite + React + shadcn/ui frontend. Auth via `better-auth/react` `adminClient` plugin. Set `VITE_API_URL` in `admin/.env` (defaults to `http://localhost:8000`). Pages: Dashboard, Organizations, OrganizationDetail, Users, Knowledge (file upload).

## TypeScript / module conventions

- ESM (`"type": "module"`), `module: NodeNext` — **all relative imports must include the `.js` extension**, even for `.ts` source files (e.g. `import { env } from './config/env.js'`).
- `strict: true`, `noUncheckedIndexedAccess: true` — array access returns `T | undefined`; handle it.
- ESLint allows `any` (`@typescript-eslint/no-explicit-any: off`) and ignores unused vars prefixed with `_`.
- Tests live under `tests/` and are excluded from `tsc` (`tsconfig.json` excludes them; Vitest type-checks at runtime).

## Error handling

`middleware/error.ts` maps:
- `HttpError` → its `status`
- `IngestError` → 400
- LLM quota / rate limit (`RESOURCE_EXHAUSTED`, `429`, `rate_limit_*`, etc.) → 429 with rate-limit guidance
- Groq/host API errors identifiable as upstream → 502
- Anything else → 500

Throw `HttpError`/`IngestError` from routes and nodes; don't write status codes inline.
