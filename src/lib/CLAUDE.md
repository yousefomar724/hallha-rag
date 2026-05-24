# src/lib — Singletons & shared services

Every file here exports a lazy `getX()` that initializes on first call. Never initialize at module top-level — env vars may not be ready, and tests need to mock before construction.

## Inventory

| File | Exports | Notes |
|---|---|---|
| `llm.ts` | `getLlm`, `getGuardrailLlm`, `getLlmWithTools` | Gemini via `@langchain/google-genai`. Models from `env.GEMINI_MODEL` / `GEMINI_GUARDRAIL_MODEL`. |
| `groq-transcription.ts` | `transcribeAudioBuffer` | Groq Whisper. Retained as a separate provider; voice-only path. |
| `embeddings.ts` | `getEmbeddings`, `HuggingFaceTransformersEmbeddings` | **PARITY-LOCKED — DO NOT EDIT.** See "Don't touch" below. |
| `pinecone.ts` | `getPineconeClient`, `getPineconeIndex` | Multi-namespace queries (global AAOIFI + `client_tenant_:{clientId}`). |
| `mongo.ts` | `getDb`, `getCheckpointer`, `closeMongo` | LangGraph `MongoDBSaver` with **distinct collection names** from the Python service. |
| `auth.ts` | `auth` (Better-Auth instance) | Admin plugin enabled. Roles: `user`/`admin`/`superadmin`, `banned` field. Mongo adapter. |
| `s3.ts` | `getS3Client`, presigned-URL helpers | Knowledge file storage. |
| `logger.ts` | `logger` | Pino singleton. Used via `pino-http` middleware. |
| `llm-errors.ts` | `parseUpstreamLlmError` | Maps Gemini/Groq/Google errors to `{ status, message, kind, provider, retryAfterSeconds }`. |
| `chat-history.ts` | `namespaceThreadId`, `upsertThreadActivity`, index helpers | Thread metadata in `chat_threads`. |
| `clients.ts` | `getClientForOrg`, CRUD | Audited-client docs for the firm. Always validates `orgId` ownership. |
| `client-documents.ts` | Metadata for ingested PDFs per client. |
| `knowledge-files.ts` | Tracking + S3 keys for global knowledge files. |
| `plans.ts` | `getPlan`, `UNLIMITED` | Plan tiers + limits (maxDocPages, audits/month). |
| `org-billing.ts` | Org usage counters. |
| `org-profile-schema.ts` | Zod for `contextSummary` etc. |
| `persona-schema.ts` | Zod for personas / firm profile. |
| `member-lookup.ts` | Org member enumeration. |

## Don't touch without coordinating

These break cross-runtime compatibility silently:

1. **`embeddings.ts`** — model (`Xenova/all-MiniLM-L6-v2`), mean-pooling, L2 normalization, 384-dim output. Pinecone is shared with the Python service; any change makes existing vectors unusable. (This file is also in `.claude/settings.json` `deny`.)
2. **`mongo.ts`** — checkpoint collection names default to `checkpoints_langgraph_js` and `checkpoint_writes_langgraph_js`, **distinct from Python's `msgpack`-serialized collections**. Don't rename to match Python or you'll deserialize garbage.
3. **`pinecone.ts`** — index name `hallha` and namespace conventions (`__default__` / `client_tenant_:{clientId}`). Python writes to the same index.

## Error parsing

`parseUpstreamLlmError(err)` recognizes Gemini (`RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`, `permission_denied`, etc.), Groq (`rate_limit_*`, status 429), and generic HTTP. Returns enough metadata for the error mapper to set HTTP status + `Retry-After`. Add new providers here, not at call sites.
