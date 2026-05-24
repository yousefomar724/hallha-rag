# HALLHA_INTEGRATION.md

Cross-repo contract between the Hallha backend and the Next.js frontend. Keep this file **identical** in both repos. When the contract changes, update both copies in the same commit.

## Repos

| Role | Path | Stack | Default port |
|---|---|---|---|
| Backend | `E:\client-projects\hallha-node` | Express 5 + LangGraph (Agentic CRAG) + DeepSeek + Pinecone + MongoDB + Better-Auth + S3 | 8000 |
| Frontend (user app) | `E:\client-projects\hallha-front-end` | Next.js 16 App Router + React 19 | 3000 |
| Admin SPA | `E:\client-projects\hallha-node\admin\` | Vite + React 19 + shadcn (pnpm workspace sibling) | 5173 |

## Auth model

- **Cookie-based session via Better-Auth.** Backend issues a session cookie on login; frontend includes it on every request.
- **Frontend** sends `credentials: "include"` on all HTTP and SSE (set in `lib/api/client.ts` `apiFetch` and `lib/api/sse.ts` `streamChatAudit`).
- **Backend** reads the cookie in `requireAuth` (`src/middleware/require-auth.ts`) and populates `req.user` + `req.activeOrgId`.
- **Roles:** `user` / `admin` / `superadmin`. The user-facing frontend is for `user`; admin/superadmin use the admin SPA.

## Env vars that must line up

| Backend (`.env`) | Frontend (`.env.local`) | Notes |
|---|---|---|
| `CORS_ORIGIN` must include the frontend origin | `NEXT_PUBLIC_API_URL` → backend origin | Both must agree on protocol + host + port. |
| `ADMIN_ORIGIN` for the admin SPA (CORS) | (admin SPA only) `VITE_API_URL` | Default dev: `http://localhost:5173` ↔ `http://localhost:8000`. |
| Better-Auth trusted origins | `NEXT_PUBLIC_AUTH_URL` → backend origin | Better-Auth needs the frontend origin allowlisted. |

## Endpoint contract

For each endpoint actually called from the frontend.

### Chat audit

| Method + Path | Backend handler | Frontend caller | Request | Response |
|---|---|---|---|---|
| `POST /chat-audit` | `src/routes/chat-audit.ts` (JSON variant) | not used directly; SSE preferred | FormData `thread_id` (required), `message?`, `file?`, `client_id?`, `isConfidential?` | `{ thread_id, client_id, response, sources, citations, confidential? }` |
| `POST /chat-audit/stream` | same file, SSE variant | `lib/api/sse.ts` `streamChatAudit` | same FormData | SSE events (see schema below) |
| `POST /chat-audit/transcribe` | same file | `lib/api/transcribe.ts` | FormData `audio` | `{ text }` |

### Chats (history)

| Method + Path | Backend handler | Frontend caller | Notes |
|---|---|---|---|
| `GET /chats` (`?clientId=...`) | `src/routes/chats.ts` | `useChatsQuery` | List threads. |
| `GET /chats/:id` | same | `useChatQuery` | Single thread + messages. |
| `DELETE /chats/:id` | same | `useDeleteChatMutation` | Removes thread + checkpoints. |

### Clients (multi-tenant audited clients)

| Method + Path | Backend handler | Frontend caller |
|---|---|---|
| `GET /api/clients` (`?search=...&includeArchived=true`) | `src/routes/clients.ts` | `useClientsQuery` |
| `POST /api/clients` | same | `useCreateClientMutation` |
| `GET /api/clients/:id` | same | `useClientQuery` |
| `PATCH /api/clients/:id` | same | `useUpdateClientMutation` |
| `POST /api/clients/:id/archive` | same | `useArchiveClientMutation` |
| `GET /api/clients/:id/documents` (`?documentType=...`) | same | `useClientDocumentsQuery` |
| `POST /api/clients/:id/documents` | same | `uploadClientDocument` (XHR — for `xhr.upload.onprogress`) |
| `DELETE /api/clients/:id/documents` | same | `useDeleteClientDocumentMutation` (body: `{ s3Key }`) |

### Organization / onboarding

| Method + Path | Frontend caller |
|---|---|
| `GET /organizations/me` | `useOrganizationQuery` |
| `PATCH /organizations/me` | `useUpdateCompanyProfileMutation` |
| `POST /organizations/me/persona` | `useSetPersonaMutation` |
| `POST /organizations/me/onboarding/skip` | `useSkipOnboardingMutation` |
| `POST /organizations/me/onboarding/business` | `useSubmitBusinessOnboardingMutation` |
| `POST /organizations/me/onboarding/auditor` | `useSubmitAuditorOnboardingMutation` |
| `POST /organizations/me/onboarding/first-client` | `useSubmitFirstClientMutation` |
| `POST /organizations/me/plan` | `useChoosePlanMutation` |

All handled in `src/routes/organizations.ts`.

### Admin (admin SPA only)

`GET /admin/stats`, `GET /admin/organizations[/:id]`, `GET /admin/users`, `POST /admin/users/:id/role|ban|unban`, `POST /upload-knowledge` — all admin-gated; not called from the user frontend.

### Auth

`/api/auth/*` is owned by Better-Auth. The frontend uses `authClient.signIn`/`signUp`/`signOut`/`useSession` from `lib/auth/client.ts` (with the `organizationClient` plugin). Don't call `/api/auth/*` manually.

## SSE event schema (`/chat-audit/stream`)

Events are emitted as `event: <name>\ndata: <json>\n\n` blocks. The frontend parser is in `lib/api/sse.ts`.

| Event | Payload | When |
|---|---|---|
| `meta` | `{ thread_id: string, client_id: string \| null, confidential?: true }` | Immediately after multipart parsing succeeds. |
| `token` | `{ text: string }` | For each LLM stream chunk (`on_chat_model_stream`). |
| `sources` | `{ sources: RetrievedSource[] }` | Once, after the audit node finishes. |
| `citations` | `{ citations: RetrievedSource[] }` | Once (duplicate of `sources` for backward compat). |
| `done` | `{ thread_id, client_id, confidential?: true }` | Final event on success. |
| `error` | `StreamErrorPayload` (see below) | Terminal — stream ends after. |

A `: keep-alive\n\n` comment is sent every 15s.

`RetrievedSource` includes `text`, `source` (filename), `page`, `headings`, `s3Key`, `s3Url`, `standard_number`, and tenant tags. See `src/agent/prompt.ts` for the canonical type.

## Error contract

Backend `src/middleware/error.ts` maps exceptions to HTTP responses:

| Cause | HTTP | Body shape |
|---|---|---|
| `HttpError(status, message)` | `status` | `{ detail: message }` |
| `IngestError(message)` | 400 | `{ detail: message }` |
| Upstream LLM quota / rate-limit | 429 | `{ detail, kind: 'quota_exhausted' \| 'rate_limited', provider: 'deepseek' \| 'gemini' \| 'groq', retryAfterSeconds? }` + `Retry-After` header |
| Upstream LLM other (5xx) | 502 | `{ detail, kind: 'upstream_error', provider }` |
| Better-Auth `APIError` | its status | `{ detail }` |
| Anything else | 500 | `{ detail: 'Internal Server Error' }` |

Frontend `apiFetch` throws `ApiError(status, detail)` on non-2xx (parses `detail` or `message` from body). SSE stream emits `error` events with `StreamErrorPayload = { detail, kind?, status?, provider?, retryAfterSeconds? }`.

TanStack Query defaults (in `app/providers.tsx`): retry skipped on 4xx, cap 2 on others; mutations never retry; `staleTime: 30s`; no refetch-on-focus.

## Multi-tenant scoping

- **Org scope.** `req.activeOrgId` from `requireAuth` gates every backend query.
- **Thread id namespacing.** Backend always converts the client-supplied `thread_id` via `namespaceThreadId(orgId, threadId, clientId?)` → `{orgId}:{userThreadId}` or `{orgId}:{clientId}:{userThreadId}`. The frontend never sees the namespaced form; backend round-trips the original `thread_id` in `meta` / `done`.
- **Client scope (audited client).** When `client_id` is in the FormData, backend validates ownership via `getClientForOrg`. Retrieval then merges Pinecone namespaces: global (`__default__`, AAOIFI standards) + `client_tenant_:{clientId}` (client documents).
- **Confidential one-shot.** `isConfidential=true` uses the ephemeral graph (no Mongo checkpoint), skips `chat_threads` write, and the response/events include `confidential: true`.

## Cross-repo dev workflow

```powershell
# Terminal 1 — backend
cd E:\client-projects\hallha-node
pnpm dev              # starts on :8000

# Terminal 2 — frontend
cd E:\client-projects\hallha-front-end
npm run dev           # starts on :3000

# Terminal 3 (one-time) — superadmin
cd E:\client-projects\hallha-node
pnpm seed:admin       # requires SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD in .env

# Terminal 4 (optional) — admin SPA
cd E:\client-projects\hallha-node
pnpm dev:admin        # starts on :5173
```

Exercise the user app at `http://localhost:3000` and the admin SPA at `http://localhost:5173`.

## When you change the contract

1. Update the backend handler.
2. Update the frontend caller (and `streamChatAudit` if it's the SSE shape).
3. Update this file in **both** repos.
4. Bump types in `src/agent/prompt.ts` (backend `RetrievedSource`) and `lib/types/retrieved-source.ts` (frontend) together.
