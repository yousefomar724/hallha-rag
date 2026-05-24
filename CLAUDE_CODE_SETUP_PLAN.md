# Claude Code Best-Practices Setup for `hallha-node` + `hallha-front-end`

## Context

We're about to add features that span both the Hallha backend (`E:\client-projects\hallha-node` — Express 5 + LangGraph + Gemini + Pinecone + MongoDB + Better-Auth) and the Hallha frontend (`E:\client-projects\hallha-front-end` — Next.js 16 App Router + React 19 + Tailwind v4 + shadcn + better-auth + TanStack Query + Zustand + SSE streaming). Anthropic's "How Claude Code works in large codebases" article identifies seven harness layers (CLAUDE.md, hooks, skills, plugins, LSP, MCP, subagents) and emphasizes that the first three — hierarchical CLAUDE.md, version-controlled settings, and ignore files — are the highest-leverage starting point.

Both repos currently have only a single verbose root `CLAUDE.md`, no `.claudeignore`, and `hallha-node` has only an ad-hoc `.claude/settings.local.json`. We're going to (1) slim each root CLAUDE.md and split detailed sections into nested `CLAUDE.md` files near the code they describe, (2) add `.claudeignore` to keep Claude out of build artifacts, (3) add a version-controlled `.claude/settings.json` with a team-friendly permissions allowlist, and (4) add a shared `HALLHA_INTEGRATION.md` to both repos so Claude can reason about cross-repo work without spelunking. We are explicitly NOT adding custom agents, hooks, or MCP servers in this pass.

## Scope (decided)

- **In:** hierarchical CLAUDE.md split, `.claudeignore`, version-controlled `.claude/settings.json`, cross-repo integration doc.
- **Out (for now):** custom subagents, hooks, MCP server configuration, LSP setup, plugins.

---

## File-by-file plan

### A. `hallha-node` (backend)

#### A1. Slim `E:\client-projects\hallha-node\CLAUDE.md`

Reduce the current root file to ~60 lines covering only:

- One-paragraph "what this repo is" (Express 5 + LangGraph Sharia auditor; sibling admin SPA under `admin/`).
- Codebase map (top-level folders with one-liners) — replaces having to grep around.
- **Critical gotchas only** (these stay at root because they cause data corruption / silent breakage if violated):
  - ESM `.js` import extension required.
  - `strict` + `noUncheckedIndexedAccess` — array access returns `T | undefined`.
  - Pinecone embedder is parity-locked with Python (`Xenova/all-MiniLM-L6-v2`, mean-pool + L2-normalize, 384-dim) — **do not change**.
  - LangGraph Mongo checkpoints are not interchangeable with Python (separate collections by default).
  - Throw `HttpError`/`IngestError` from routes/nodes; never inline status codes.
- Pointers to nested CLAUDE.md files (so Claude knows to load them when working in those dirs).
- Pointer to `HALLHA_INTEGRATION.md` for cross-repo API contract.
- Commands cheat-sheet (`pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm seed:admin`).

Move everything else to nested files (below).

#### A2. New nested `CLAUDE.md` files

| Path | Covers |
|---|---|
| `src/CLAUDE.md` | ESM/import-extension rule restated (since this is where most edits happen), TypeScript strictness reminder, lazy-singleton pattern, error-handling conventions (`HttpError`, `IngestError`), how `app.ts` is structured (factory, no listener) so tests can mount it. |
| `src/agent/CLAUDE.md` | LangGraph state shape (`Annotation.Root`, channels & reducers), node responsibilities (`greetingReplyNode` / `guardrailNode` / `retrieveShariaRules` / `shariaAuditNode`), routing logic, `getCompiledGraph()` vs `getEphemeralGraph()` (confidential one-shot), prompt construction in `prompt.ts`, structured-output patterns. |
| `src/routes/CLAUDE.md` | Request flow per endpoint (`/chat-audit`, `/upload-knowledge`, `/chats`, `/clients`, `/organizations`, `/admin/*`), multer setup (`memoryUpload` vs `diskUpload` vs `voiceUpload`), auth/admin middleware composition, multi-tenant client-scope rules. |
| `src/lib/CLAUDE.md` | Singleton inventory (one-liner per file: `llm.ts`, `embeddings.ts`, `pinecone.ts`, `mongo.ts`, `auth.ts`, `s3.ts`, `logger.ts`, `groq-transcription.ts`, `llm-errors.ts`, `chat-history.ts`, `clients.ts`, `client-documents.ts`, `knowledge-files.ts`, `plans.ts`, `org-billing.ts`), the **don't-touch-without-care** list (embeddings model/pooling/norm; Mongo checkpointer collection names). |
| `src/rag/CLAUDE.md` | Ingest pipeline (PDF → pdf2md → heading-aware split → 1800/150 fallback → embed → upsert), namespace strategy (global AAOIFI vs `client_tenant_:{clientId}`), metadata schema (`headings`, `page`, `source`, `s3Key`, `standard_number`), cross-runtime parity note (Node chunks carry `headings`; Python chunks do not). |
| `src/middleware/CLAUDE.md` | Error mapper precedence (HttpError → IngestError → upstream-LLM-quota → upstream-LLM-other → 500), rate-limit tiers, `requireAuth` / `requireAdmin` / `requireSuperadmin` composition, `usage-limit` plan gating. |
| `tests/CLAUDE.md` | Vitest setup (fake env vars injected by `vitest.config.ts`), mock-at-the-module-boundary discipline (never hit real LLM/Pinecone/S3), `test-helpers/auth-flow.ts` for session cookies, `createApp` import from `src/app.ts` (no listener). |
| `admin/CLAUDE.md` | Vite + React 19 + shadcn/ui admin SPA stack, `better-auth/react` with `adminClient` plugin, route structure (Login/Dashboard/Organizations/OrganizationDetail/Users/Knowledge/AuditedClients), TanStack Query for server state, `ProtectedRoute` auth gate. |
| `scripts/CLAUDE.md` | One-liner per script (`seed-superadmin.ts`, `backfill-knowledge-files.ts`, `dev-auth-smoke.ts`) and how to run each. |

**Pattern:** each nested file is short (20–80 lines), focused on local conventions, and assumes the root file has already been read.

#### A3. `E:\client-projects\hallha-node\.claudeignore`

```
node_modules/
admin/node_modules/
dist/
admin/dist/
uploads/
coverage/
.pnpm-store/
*.tsbuildinfo
```

Rationale: these are either generated (`dist`, `admin/dist`, `tsbuildinfo`), third-party (`node_modules`), or runtime data (`uploads/`).

#### A4. `E:\client-projects\hallha-node\.claude\settings.json` (version-controlled, team-shared)

```jsonc
{
  "permissions": {
    "allow": [
      // pnpm
      "Bash(pnpm test*)",
      "Bash(pnpm typecheck*)",
      "Bash(pnpm lint*)",
      "Bash(pnpm format*)",
      "Bash(pnpm build*)",
      "Bash(pnpm dev*)",
      "Bash(pnpm install*)",
      // git read-only
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git show*)",
      "Bash(git branch*)",
      // node + tsx invocations
      "Bash(node --version)",
      "Bash(tsx*)",
      // safe filesystem inspection on Windows
      "Bash(Get-ChildItem*)",
      "Bash(Test-Path*)"
    ],
    "deny": [
      // protect cross-runtime parity surfaces
      "Edit(src/lib/embeddings.ts)",
      "Write(src/lib/embeddings.ts)"
    ]
  }
}
```

Leave `.claude/settings.local.json` for individual contributors' machine-specific overrides (not committed). The existing local file stays untouched.

---

### B. `hallha-front-end` (frontend)

#### B1. Slim `E:\client-projects\hallha-front-end\CLAUDE.md`

Reduce to ~60 lines covering only:

- One-paragraph "what this repo is" (Next.js 16 App Router frontend for Hallha auditor; pairs with backend at `E:\client-projects\hallha-node`).
- Codebase map (top-level folders with one-liners).
- **Critical gotchas only:**
  - Locale defaults to Arabic (`ar`) via cookie; **every layout** must call `getLocale()` and wrap in `DirectionProvider`.
  - All UI text via i18n keys (`messages/ar.json`, `messages/en.json`) — never hardcode strings.
  - Use logical Tailwind properties (`ms-`, `me-`, `text-start/end`) and theme tokens (`bg-background`, `text-foreground`), not raw colors.
  - Server components by default; add `"use client"` only when hooks/browser APIs needed.
  - Don't bypass the `useChatStore` Zustand store during SSE streaming.
  - **No test runner is configured** — verify with `npm run typecheck`, `npm run lint`, and manual browser exercise.
- Pointers to nested CLAUDE.md files.
- Pointer to `HALLHA_INTEGRATION.md`.
- Commands cheat-sheet (`npm run dev`, `build`, `typecheck`, `lint`, `format`, `pwa:icons`).

#### B2. New nested `CLAUDE.md` files

| Path | Covers |
|---|---|
| `app/CLAUDE.md` | App Router route-group layout (`(landing)`, `(auth)`, `(dashboard)`), root layout chain (fonts → `NextIntlClientProvider` → `ThemeProvider` → `TooltipProvider` → `Providers`), where PWA pieces live (`sw.ts`, `manifest.ts`, `~offline/`), server-vs-client boundaries. |
| `components/CLAUDE.md` | Folder taxonomy (`ui/` = shadcn primitives + `direction.tsx`; feature folders `chat/`, `auth/`, `dashboard/`, `landing/`, `layout/`, `settings/`), how to add a shadcn component (`npx shadcn@latest add <name>` — style `radix-nova`), React 19 no-forwardRef convention. |
| `components/chat/CLAUDE.md` | Chat-shell architecture (sidebar + window + composer), SSE streaming wiring (composer → `streamChatAudit` → Zustand `useChatStore` → message render), voice-recording flow, file-upload progress (XMLHttpRequest), client-scoped chat (`client_id` in FormData). |
| `lib/api/CLAUDE.md` | `apiFetch()` contract (credentials, `ApiError` shape), query-key factories (`chatKeys`, `clientKeys`, `organizationKeys`), TanStack Query defaults (30s staleTime, no refetch-on-focus, skip retry on 4xx), SSE client (`streamChatAudit` parses `meta`/`token`/`sources`/`done`/`error` events), upload progress via XHR not fetch. |
| `lib/stores/CLAUDE.md` | Zustand stores (`chat.ts`, `register-draft.ts`), what's persisted vs ephemeral, how SSE feeds the chat store, abort-controller pattern. |
| `lib/schemas/CLAUDE.md` | Zod schemas (`auth`, `onboarding`, `organization`), error messages are i18n **keys** resolved at render, integration with shadcn `Form` + react-hook-form. |
| `lib/auth/CLAUDE.md` | `better-auth/react` client setup, `organizationClient` plugin, session hook usage, `credentials: "include"` everywhere. |
| `messages/CLAUDE.md` | Key naming conventions (kebab, namespaced by feature), AR-first authoring (translate to EN second), how to test RTL pairing. |

#### B3. `E:\client-projects\hallha-front-end\.claudeignore`

```
node_modules/
.next/
.cursor/
coverage/
dist/
build/
out/
.turbo/
.vercel/
public/sw.js
*.tsbuildinfo
.DS_Store
```

#### B4. `E:\client-projects\hallha-front-end\.claude\settings.json` (version-controlled)

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(npm run dev*)",
      "Bash(npm run build*)",
      "Bash(npm run typecheck*)",
      "Bash(npm run lint*)",
      "Bash(npm run format*)",
      "Bash(npm run pwa:icons*)",
      "Bash(npm install*)",
      "Bash(npx shadcn*)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git show*)",
      "Bash(git branch*)",
      "Bash(Get-ChildItem*)",
      "Bash(Test-Path*)"
    ]
  }
}
```

No `deny` list needed here — there are no parity-locked files like backend's `embeddings.ts`.

---

### C. Shared `HALLHA_INTEGRATION.md` (in BOTH repos, kept in sync)

A single-source-of-truth document describing the API contract between the two repos. Placed at the root of each repo so Claude loads it when starting from either side. Identical content (or one is a copy of the other) — when the contract changes, both files update.

**Contents:**

1. **Repo locations.** `hallha-node` (backend, Express 5, port 8000) and `hallha-front-end` (frontend, Next.js, port 3000). Absolute paths so Claude can `cd` to the sibling.

2. **Auth model.** Cookie-based session via `better-auth`. Frontend sends `credentials: "include"`; backend reads session in `requireAuth` middleware and populates `req.user` + `req.activeOrgId`. Roles: `user` / `admin` / `superadmin`.

3. **Environment variables that must line up.** Backend `CORS_ORIGIN` must include frontend's origin; frontend `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_AUTH_URL` must point at the backend (default `http://localhost:8000`).

4. **Endpoint contract** — for each endpoint actually used by the frontend (sourced from the explore report):
   - Method + path
   - Backend handler file
   - Frontend caller file + hook name
   - Request shape (JSON or FormData fields)
   - Response shape (success + `ApiError` JSON: `{ status, detail, kind?, provider?, retryAfterSeconds? }`)

   Endpoints to document:
   - `POST /chat-audit/stream` (SSE; FormData `thread_id`, `message`, `file`, `client_id`; events `meta` / `token` / `sources` / `done` / `error`)
   - `POST /chat-audit/transcribe` (FormData `audio` → `{ text }`)
   - `GET /chats`, `GET /chats/:id`, `DELETE /chats/:id`
   - `GET|POST|PATCH /api/clients`, `POST /api/clients/:id/archive`
   - `GET|POST|DELETE /api/clients/:id/documents`
   - `GET|PATCH /organizations/me`
   - `POST /organizations/me/persona|onboarding/skip|onboarding/business|onboarding/auditor|onboarding/first-client|plan`
   - `GET /admin/stats`, `GET /admin/organizations[/:id]`, `GET /admin/users`, `POST /admin/users/:id/role|ban|unban`
   - `POST /upload-knowledge` (admin only)

5. **SSE event schema.** Exact JSON shape of each event the backend emits and the frontend parses, since this isn't a typed REST call.

6. **Error contract.** Backend `middleware/error.ts` maps `HttpError` / `IngestError` / upstream-LLM-quota / upstream-LLM-other → HTTP status + JSON body. Frontend `apiFetch` throws `ApiError(status, detail)`; SSE stream emits `error` events with `StreamErrorPayload`. TanStack Query skips retry on 4xx.

7. **Multi-tenant scoping.** Backend namespaces threads as `{orgId}:{userThreadId}` for checkpointing; Pinecone retrieval merges global AAOIFI + per-client (`client_tenant_:{clientId}`) namespaces; frontend passes `client_id` in chat FormData to scope a chat to a client.

8. **Cross-repo dev workflow.** Start backend (`pnpm dev` in `hallha-node`) → start frontend (`npm run dev` in `hallha-front-end`) → seed superadmin (`pnpm seed:admin`) → exercise via browser at `http://localhost:3000`.

---

## Critical files to be modified or created

**hallha-node:**
- `CLAUDE.md` (edit — slim it down)
- `.claudeignore` (new)
- `.claude/settings.json` (new — version-controlled)
- `HALLHA_INTEGRATION.md` (new)
- `src/CLAUDE.md`, `src/agent/CLAUDE.md`, `src/routes/CLAUDE.md`, `src/lib/CLAUDE.md`, `src/rag/CLAUDE.md`, `src/middleware/CLAUDE.md`, `tests/CLAUDE.md`, `admin/CLAUDE.md`, `scripts/CLAUDE.md` (all new)

**hallha-front-end:**
- `CLAUDE.md` (edit — slim it down)
- `.claudeignore` (new)
- `.claude/settings.json` (new — version-controlled)
- `HALLHA_INTEGRATION.md` (new)
- `app/CLAUDE.md`, `components/CLAUDE.md`, `components/chat/CLAUDE.md`, `lib/api/CLAUDE.md`, `lib/stores/CLAUDE.md`, `lib/schemas/CLAUDE.md`, `lib/auth/CLAUDE.md`, `messages/CLAUDE.md` (all new)

**Memory pointer (per saved feedback `feedback_plan_files.md`):** also copy this plan file to each repo root as `CLAUDE_CODE_SETUP_PLAN.md` so a future session sees it without needing the user's `.claude/plans/` path.

---

## Verification

1. **Open each repo cold (in a fresh Claude Code session) and ask a question that requires nested context:**
   - In `hallha-node`: "Why does `embeddings.ts` use mean-pooling and L2-normalize?" — confirm Claude finds the answer via the root gotchas section without spelunking.
   - In `hallha-node`: "How do I add a new node to the audit graph?" — confirm Claude reads `src/agent/CLAUDE.md`.
   - In `hallha-front-end`: "Add a new shadcn dialog component" — confirm Claude reads `components/CLAUDE.md` and uses `npx shadcn@latest add` with style `radix-nova`.
   - In `hallha-front-end`: "Why does the document upload use XMLHttpRequest instead of fetch?" — confirm answer comes from `lib/api/CLAUDE.md`.

2. **Cross-repo question (from either repo):** "If I change the `client_id` field name in the chat-audit stream, what frontend files need to change?" — confirm Claude consults `HALLHA_INTEGRATION.md` and points at `lib/api/sse.ts` and the chat composer.

3. **Verify `.claudeignore` works:** run a broad `Glob "**/*.ts"` in each repo and confirm `node_modules/`, `.next/`, `dist/` aren't enumerated.

4. **Verify `.claude/settings.json` works:** start a fresh session and run `pnpm typecheck` (backend) / `npm run typecheck` (frontend) — confirm no permission prompt.

5. **Verify nothing breaks:** `pnpm test`, `pnpm typecheck`, `pnpm lint` (backend) and `npm run typecheck`, `npm run lint` (frontend) must still pass. None of these changes touch executable code, so this is a sanity check rather than a regression test.
