# src/routes — Express routers

Each router file owns one endpoint family. All mounted in `app.ts`.

## Middleware composition

Most routes stack: `requireAuth` → rate-limit (minute + hourly) → `usageLimitAudit()` → multer → handler. Admin routes use `requireAdmin` or `requireSuperadmin` instead of `requireAuth`. See `middleware/CLAUDE.md`.

## Routes

### `chat-audit.ts` — audit endpoints

- `POST /chat-audit` (JSON response) and `POST /chat-audit/stream` (SSE). Both accept multipart with `thread_id` (required), `message`, `file` (PDF or text), `client_id` (optional), `isConfidential` (optional bool).
- `prepareAuditInputs()` is shared between JSON and SSE paths. It validates `thread_id`, looks up `client_id` ownership via `getClientForOrg(activeOrgId, clientId)` (404 if not owned), loads org `contextSummary`, extracts PDF text via `extractPdfText` (page-cap from plan), and namespaces the thread id.
- SSE event names: `meta`, `token`, `sources`, `citations`, `done`, `error`. Heartbeat `: keep-alive\n\n` every 15s. Aborts on `req.close`.
- Confidential mode (`isConfidential=true`): uses `getEphemeralGraph()`, skips `upsertThreadActivity`, adds `confidential: true` to events.
- `POST /chat-audit/transcribe` — Groq Whisper (`voiceUpload.single('audio')` → `transcribeAudioBuffer`).

### `upload-knowledge.ts` — knowledge ingest

- `POST /upload-knowledge`, admin-gated. `diskUpload` writes the PDF to `./uploads/` then `ingestPdfToPinecone` processes it. See `rag/CLAUDE.md`.

### `chats.ts` — saved conversations

- `GET /chats` (list, query `?clientId=`), `GET /chats/:id`, `DELETE /chats/:id`. Reads `chat_threads` collection populated by `upsertThreadActivity`.

### `clients.ts` — firm's audited clients (multi-tenant)

- `GET|POST /api/clients`, `GET|PATCH /api/clients/:id`, `POST /api/clients/:id/archive`.
- Documents subroute: `GET|POST|DELETE /api/clients/:id/documents` + `GET /api/clients/:id/documents/:documentId/status`. Upload uses S3 + Pinecone namespace `client_tenant_:{clientId}`.
- **Async ingest pattern (POST returns 202).** The upload route only does S3 transport + Mongo row insert (`status: 'pending'`) inline, then schedules `processClientDocumentIngest` (in `src/lib/client-ingest.ts`) via `setImmediate` and responds **202 Accepted** with `{ documentId, statusUrl, document }`. The background job runs `ingestPdfToPinecone` and flips the row to `ready` (incrementing `documentCount`) or `failed` (with `error`). Frontend polls `statusUrl`. This avoids 504s caused by sync ingest exceeding gateway timeouts on cold-start embedding-model loads. Boot-time `recoverStalePendingIngests` marks any `pending` rows >5min old as `failed` (we don't persist the upload buffer across restarts).

### `organizations.ts` — org/onboarding

- `GET|PATCH /organizations/me`, `POST /organizations/me/persona|onboarding/{skip,business,auditor,first-client}|plan`. Drives the frontend register wizard.

### `admin.ts` — platform admin (admin SPA)

- `GET /admin/stats`, `GET /admin/organizations[/:id]`, `GET /admin/users`. Superadmin-only mutations: `POST /admin/users/:id/role|ban|unban` (Better-Auth admin plugin).

## Multi-tenant rules

- **Org scope.** `req.activeOrgId` (from `requireAuth`) gates every query. Thread ids are namespaced `{orgId}:{userThreadId}` or `{orgId}:{clientId}:{userThreadId}`.
- **Client scope.** When `client_id` is passed, validate ownership via `getClientForOrg`. Retrieval merges global AAOIFI + `client_tenant_:{clientId}` namespaces. Never trust the client_id without validation.
- **Confidential.** Confidential chats don't write to `chat_threads` and use the ephemeral graph (no Mongo checkpoints).
