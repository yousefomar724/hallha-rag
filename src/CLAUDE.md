# src/

Express 5 server source. ESM (`"type": "module"`).

## Hard rules

- **Every relative import must include the `.js` extension** even when importing a `.ts` file: `import { env } from './config/env.js'`. `module: NodeNext` won't resolve extensionless imports.
- **`noUncheckedIndexedAccess` is on.** `arr[i]` returns `T | undefined`. Guard before use; don't `!`-assert unless you've already null-checked.
- ESLint allows `any`; unused params/vars must be prefixed with `_`.

## Layout

| Folder | What lives here |
|---|---|
| `agent/` | LangGraph workflow: state, nodes, prompts, tools, guardrail, retrieval. See `agent/CLAUDE.md`. |
| `config/` | Zod-validated env (`env.ts`). Calls `process.exit(1)` on parse failure. |
| `lib/` | Lazy singletons + shared services (LLM, embeddings, Pinecone, Mongo, S3, auth, logger). See `lib/CLAUDE.md`. |
| `middleware/` | Express middleware (auth, admin gate, error mapper, rate limit, multer, usage limit). See `middleware/CLAUDE.md`. |
| `openapi/` | Swagger UI install + OpenAPI spec builder (mounted at `/docs` when `SWAGGER_ENABLED=true`). |
| `rag/` | PDF ingestion → Pinecone. See `rag/CLAUDE.md`. |
| `routes/` | Express routers. See `routes/CLAUDE.md`. |
| `types/` | Express `Request` augmentation (`req.user`, `req.activeOrgId`). |
| `utils/` | Pure helpers: `pdf.ts`, `pdf-to-markdown.ts`, `markdown-header-splitter.ts`, `standard-number.ts`. |
| `app.ts` | App factory — CORS, Better-Auth router mount, middleware, route mounting. **Returns the app, doesn't listen.** Tests import this directly. |
| `index.ts` | Bootstrap: ensures Mongo indexes, calls `app.listen()`, registers `SIGINT`/`SIGTERM` → `closeMongo()`. |

## Patterns

- **Lazy singletons.** `lib/*.ts` modules export `getThing()` that initializes on first call and caches. Don't initialize at import time — env vars may not be loaded yet, and tests need to mock the module before construction.
- **Throw, don't write status.** Routes/nodes throw `HttpError(status, message)` or `IngestError(message)`. The error mapper in `middleware/error.ts` translates them to JSON responses. Never call `res.status(...).json(...)` for error paths inline.
- **Partial state updates from LangGraph nodes.** Nodes return `Partial<AgentStateUpdate>`. The reducers in `agent/state.ts` merge them; `messages` appends, other channels replace.

## Testing

`createApp` from `app.ts` is the test entrypoint — never spin up `index.ts`. See `tests/CLAUDE.md`.
