# CLAUDE.md — hallha-node

Express 5 + TypeScript Sharia-compliance auditor. Two main endpoints (`/upload-knowledge`, `/chat-audit`) sit in front of a LangGraph agent backed by Pinecone (RAG), MongoDB (per-thread memory + checkpoints), Better-Auth (sessions), S3 (knowledge files), and **OpenRouter** (LLM — `deepseek/deepseek-r1` for compliance reasoning + report synthesis, `deepseek/deepseek-chat` for guardrail / clause parsing / CRAG evaluator / chat-Q&A; Groq retained for Whisper transcription only). The `admin/` workspace package is the platform-admin SPA (Vite + React 19 + shadcn).

The document-upload path runs an **Agentic Corrective RAG (CRAG)** loop: hierarchical clause parsing → per-clause retrieval → relevance evaluator (with query rewriting, capped at 2 attempts) → structured Sharia reasoning → autonomous purification calculator → final report synthesis. The non-document chat path remains a simpler retrieve→Q&A flow with Tavily web search.

For cross-repo work with the Next.js frontend, see [`HALLHA_INTEGRATION.md`](./HALLHA_INTEGRATION.md).

## Codebase map

| Path | What it is |
|---|---|
| `src/` | Express app source. ESM, strict TS. → [`src/CLAUDE.md`](src/CLAUDE.md) |
| `src/agent/` | LangGraph state, nodes, prompts, routing. → [`src/agent/CLAUDE.md`](src/agent/CLAUDE.md) |
| `src/routes/` | Express routers (chat-audit, chats, clients, organizations, admin, upload-knowledge). → [`src/routes/CLAUDE.md`](src/routes/CLAUDE.md) |
| `src/lib/` | Lazy singletons: LLM, embeddings, Pinecone, Mongo, S3, auth, logger. → [`src/lib/CLAUDE.md`](src/lib/CLAUDE.md) |
| `src/middleware/` | Auth, admin gate, error mapper, rate limit, multer, usage limit. → [`src/middleware/CLAUDE.md`](src/middleware/CLAUDE.md) |
| `src/rag/` | PDF → Pinecone ingest. → [`src/rag/CLAUDE.md`](src/rag/CLAUDE.md) |
| `src/openapi/` | Swagger UI (`/docs` when `SWAGGER_ENABLED=true`). |
| `src/utils/` | PDF extract, markdown header splitter, standard-number parsing. |
| `src/config/env.ts` | Zod-validated env; `process.exit(1)` on parse failure. |
| `admin/` | Vite + React admin SPA. → [`admin/CLAUDE.md`](admin/CLAUDE.md) |
| `tests/` | Vitest. Mock external services at the module boundary. → [`tests/CLAUDE.md`](tests/CLAUDE.md) |
| `scripts/` | `seed-superadmin`, `backfill-knowledge-files`, `dev-auth-smoke`. → [`scripts/CLAUDE.md`](scripts/CLAUDE.md) |

## Critical gotchas (read before editing)

1. **ESM + NodeNext.** Every relative import needs the `.js` extension, even when the source is `.ts`: `import { env } from './config/env.js'`.
2. **`noUncheckedIndexedAccess` is on.** `arr[i]` returns `T | undefined`. Don't `!`-assert without a guard.
3. **Don't touch `src/lib/embeddings.ts`.** Pinecone is shared with a Python service; vectors must stay numerically identical (model `Xenova/all-MiniLM-L6-v2`, mean-pool + L2-normalize, 384-dim). This file is in `.claude/settings.json` `deny`.
4. **Don't touch Mongo checkpoint collection names** (`checkpoints_langgraph_js`, `checkpoint_writes_langgraph_js`). Python uses `msgpack`-serialized collections; cross-loading deserializes garbage.
5. **Throw errors, don't write status codes.** Routes/nodes throw `HttpError`/`IngestError`; the mapper in `middleware/error.ts` translates them. Never `res.status(...).json(...)` for error paths.
6. **Don't retry LLM calls in nodes.** Quota/429 errors must surface so the mapper returns 429 + `Retry-After`. Retrying in-graph blocks clients for minutes.
7. **Validate `client_id` ownership** via `getClientForOrg(activeOrgId, clientId)` before scoping retrieval. Never trust the multipart field.

## Commands

```bash
pnpm dev                       # tsx watch (port 8000)
pnpm test                      # vitest run    (one file: pnpm test tests/chat-audit.test.ts)
pnpm typecheck                 # tsc --noEmit
pnpm lint / pnpm format
pnpm build                     # tsc → dist/
pnpm start                     # node dist/

pnpm dev:admin / pnpm build:admin
pnpm seed:admin                # idempotent superadmin (requires SEED_ADMIN_* in .env)
```

## Env (required)

`OPENROUTER_API_KEY`, `GROQ_API_KEY` (Whisper only), `PINECONE_API_KEY`, `MONGO_URI`. Optional `OPENROUTER_REASONING_MODEL=deepseek/deepseek-r1`, `OPENROUTER_CHAT_MODEL=deepseek/deepseek-chat`, `OPENROUTER_HTTP_REFERER=http://localhost:3000`, `OPENROUTER_APP_TITLE=Hallha Sharia Auditor`, `PORT=8000`, `CORS_ORIGIN`, `PINECONE_INDEX=hallha`, `MONGO_DB_NAME=sharia_app`, `MONGO_CHECKPOINT_COLLECTION=checkpoints_langgraph_js`, `MONGO_CHECKPOINT_WRITES_COLLECTION=checkpoint_writes_langgraph_js`, `ADMIN_ORIGIN=http://localhost:5173`. Legacy `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_*` are accepted but unused. Any `LANGSMITH_*` enables auto-tracing. See `src/config/env.ts` for the full Zod schema.
