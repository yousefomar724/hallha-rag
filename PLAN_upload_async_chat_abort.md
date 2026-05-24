# Plan — Frontend i18n + UX polish, robust upload, fix chat-stop

## Context

The Hallha frontend (`E:\client-projects\hallha-front-end`, Next.js 15 + next-intl + shadcn + Tailwind v4) was extended recently with **client management pages** (`/clients`, `/clients/[clientId]`, `/clients/[clientId]/chat`) but those screens shipped with hard-coded English strings, no visible theme toggle, weak sidebar navigation (the `app-sidebar` still has placeholder "Acme Inc / Playground / Models" content), and a plain `<input type=file>` for knowledge-file upload. In production:

- File upload hangs and returns **504 Gateway Timeout** even for tiny files. Root cause is two-fold: the embedding model (`Xenova/all-MiniLM-L6-v2`, ~90 MB ONNX) is lazy-loaded on first request and adds 30–60 s of cold start, and the entire pipeline (S3 put → PDF parse → embed → Pinecone upsert) runs *synchronously inside the request handler*, so any moderately sized PDF blows past the gateway's 60 s budget.
- The **stop button** during chat streaming triggers an `AbortController.abort()` correctly, but the React Query cache then refetches `GET /chats/:thread_id`, which 404s because the thread is only persisted at the END of `/chat-audit/stream` (after `recordThreadActivity`). The user sees `"المحادثة غير موجودة" / "Chat not found"`.

Goal: ship a single coherent change that (a) makes the new clients flow feel native (Arabic-first, themed, navigable, drag-drop upload), and (b) eliminates the two production bugs with the minimum new infrastructure (no Redis, no new queue service — use what we already have: Mongo + Express background tasks).

## Hard constraints (do not violate)

- **Do not touch `src/lib/embeddings.ts`** — Pinecone vectors are parity-locked with a Python service.
- **Do not rename Mongo checkpoint collections.**
- **ESM + `.js` import extensions** on the backend; **next-intl namespaces** on the frontend.
- **SSE contract in `HALLHA_INTEGRATION.md` is frozen** — no shape changes to `token` / `sources` / `citations` / `done`.
- **Throw `HttpError`, never write status codes** in route handlers.
- **Default locale stays `ar`** (RTL). All new strings must exist in both `messages/en.json` and `messages/ar.json`.

---

## Part 1 — Clients pages translation + UX polish (frontend)

### 1a. Extract hardcoded strings to next-intl

Add two new namespaces to `messages/en.json` and `messages/ar.json`:

- `app.clients` — list-page strings (title, description, "New client", dialog labels, empty state, "documents" suffix, "No industry" fallback, loading/creating states).
- `app.clientDetail` — detail-page strings (section headers "Upload a document" / "Documents", delete-confirm, empty state, "Start chat about this client", upload progress label).

Replace literals in:
- `app/(dashboard)/clients/page.tsx`
- `app/(dashboard)/clients/[clientId]/page.tsx`
- `app/(dashboard)/clients/[clientId]/chat/page.tsx`

Reference pattern (already used elsewhere): `const t = useTranslations("app.clients"); t("newClient")`.

Also audit any other recently added pages — grep for raw English strings in JSX in `app/(dashboard)/**` and any new components under `components/clients/**` if they exist.

### 1b. Navigation: surface "Clients" in the main sidebar

`components/app-sidebar.tsx` currently uses placeholder NavMain data (Playground, Models, Documentation, Settings). Replace with a real menu sourced from a small `lib/nav.ts` config:

- **Dashboard** → `/dashboard`
- **Chats** → `/dashboard` (active chat shell) or `/chats` if a list exists
- **Clients** → `/clients`  ← primary new entry
- **Knowledge** (if a route exists) → `/knowledge`

Keep `TeamSwitcher` and `NavUser` as-is. Items use `useTranslations("app.nav")` for labels (add namespace). Active state via `usePathname()` + `startsWith`. Icons from `lucide-react` (Users for Clients).

On the chat page (`/dashboard`), add a small "Clients" entry-point chip near the composer header or in the empty-state — e.g. "Audit a client's document" → `/clients`. Two click-paths: sidebar (persistent) and contextual (chat empty state).

On each client-detail page, add a back button → `/clients` and a breadcrumb (`Clients › {client name}`) using `components/ui/breadcrumb.tsx` (already in shadcn).

### 1c. Visible theme toggle

Today theme switching is hidden behind a keyboard "d" hotkey (`components/theme-provider.tsx`). Add a visible toggle:

- **Primary location:** in the user dropdown (`components/nav-user.tsx`) — add a "Theme" submenu with Light / Dark / System items, using `useTheme()` from `next-themes`. Pattern: `DropdownMenuSub` + `DropdownMenuSubTrigger` + three `DropdownMenuRadioItem`s.
- **Secondary location:** a compact icon button (sun/moon) in the sidebar footer next to `NavUser`, for one-click toggle. `lucide-react` `Sun` / `Moon` swapped via `theme === 'dark'`.

Keep the keyboard hotkey. Add labels under `app.theme` (`light`, `dark`, `system`).

### 1d. UI polish on clients pages

Focused, not a redesign:

- Clients list (`page.tsx`): convert the bare list into a responsive grid of cards (`components/ui/card.tsx`), each showing client name, industry badge, document count, last-activity timestamp. Empty state gets a centered icon + CTA.
- Client detail page: split into two columns on `md+`: left = "Documents" table, right = "Upload" panel (sticky on scroll). Mobile stays stacked.
- Add a `Skeleton` (`components/ui/skeleton.tsx`) loading state to replace the "Loading…" text.

---

## Part 2 — Better upload UX: drag-and-drop + multi-case + 504 fix

### Frontend uploader (`components/clients/document-uploader.tsx`, NEW)

Extract the inline upload form into a `<DocumentUploader clientId=… />` component using `react-dropzone` (add dep):

- Large drop zone — accepts PDF only for now (matches backend). Drop OR click to open file picker. Shows file name, size, MIME on selection. Client-side validation: max size (e.g. 25 MB), accept `application/pdf` + `.pdf`.
- `multiple` enabled — queues files, uploads them **serially** (so backend ingest doesn't get crushed), shows per-file progress rows.
- Per row: filename, size, transport progress bar (0–100%), then "Processing…" spinner while polling, then ✓ Ready / ✗ Failed with retry. "Replace" affordance for the 'failed' state.
- Each row has a Cancel button → `xhr.abort()` + DELETE the pending document on backend if it was already created.

### Frontend upload client (`lib/api/queries/clients.ts`)

Replace `XMLHttpRequest`-only `uploadClientDocument` with one that:
- Still uses `XMLHttpRequest` (needed for `xhr.upload.onprogress`; `fetch` lacks it).
- Sets `xhr.timeout = 0` (no client timeout — wait for the 202).
- Returns `{ documentId, statusUrl }` (backend will switch to 202 Accepted; see below).
- New hook `useDocumentStatusQuery(clientId, documentId)` — `useQuery` with `refetchInterval: 2000` that stops once `status` is `ready` or `failed`.

### Backend changes (`E:\client-projects\hallha-node`)

Without adding Redis/Bull — use only what we already have (Mongo + Node):

- `src/routes/clients.ts` — split `POST /api/clients/:clientId/documents`:
  1. **Transport phase (sync, fast):** receive multipart, validate, write to S3, insert a `client_documents` row with `status: 'pending'` and `s3Key`. Respond **202 Accepted** with `{ documentId, statusUrl: '/api/clients/:clientId/documents/:documentId/status' }`. No PDF parsing or embedding here.
  2. **Ingest phase (async, fire-and-forget):** kick off `processClientDocumentIngest(documentId)` *after* sending the response via `setImmediate(() => fn().catch(logAndMarkFailed))`. This wraps existing `ingestPdfToPinecone()` and updates the Mongo row to `status: 'ready'` (with chunk count, page count) or `status: 'failed'` (with error message) when done.
- Add `GET /api/clients/:clientId/documents/:documentId/status` → `{ status, progress?, chunkCount?, error? }`.
- **Pre-warm the embedding model at boot.** In `src/index.ts`, after Mongo/Pinecone connect but before `app.listen`: `await getEmbeddings().embedQuery("warmup");` — eliminates the 30–60 s cold start on first user request.
- Server timeout: explicitly set `server.requestTimeout` and `server.headersTimeout` to ~300 s on the Node HTTP server so the upload transport itself never gets cut. Document in CLAUDE.md.
- **Boot janitor** (`src/lib/ingest-recovery.ts`, NEW): on startup, scan `client_documents` for `status: 'pending'` rows older than 5 min and either re-enqueue or mark `failed` with "Server restarted during ingest — please retry." Called once from `src/index.ts`.

Zero new infrastructure. The "background job" is just a Node async function that survives the request because Node keeps the event loop alive. The status field gives the frontend a clean polling target. The pre-warm fixes the "tiny file 504" symptom specifically.

### Data shape

`client_documents` (Mongo) gains two fields — no migration needed (Mongo is schemaless):
- `status: 'pending' | 'ready' | 'failed'` (default `ready` on read for legacy rows)
- `error?: string` (set when `status === 'failed'`)

Update list/detail queries to surface status so the UI can show pending/failed badges.

---

## Part 3 — Fix the "chat not found" abort error

Two-sided fix (robust against page reload AND late refetch):

### Backend (`E:\client-projects\hallha-node\src\routes\chat-audit.ts`)

Move the `recordThreadActivity` call (currently inside the post-stream success branch around line 323) to **before** `graph.streamEvents(...)` begins. The thread row should exist the moment the stream starts — whether the stream completes, aborts, or errors, the thread is persisted with the user's input message. On successful completion, update it with the assistant response; on abort (req.close handler), leave the user message recorded and optionally mark `lastStatus: 'aborted'`.

Verify `findThreadOwned` returns it correctly so `GET /chats/:id` no longer 404s. No SSE contract change — the `meta` event still includes `thread_id` as today.

### Frontend (`lib/api/queries/chats.ts` + `lib/stores/chat.ts`)

- In `useSendChatStream`, when the catch block sees `error.name === 'AbortError'` (or `signal.aborted`), do NOT show the "chat not found" toast. Instead optimistically write the partial assistant message + sources collected so far (already in the Zustand store as `streamingText` / `streamingSources`) into the React Query cache for `chatKeys.detail(threadId)`.
- Then schedule one `qc.invalidateQueries({ queryKey: chatKeys.detail(threadId) })` so the next refetch syncs from the now-persisted backend row (which exists thanks to the backend fix above).
- In the Zustand `abortStreaming` action, preserve a `lastAbortedSnapshot` so the chat list immediately shows the abandoned thread without flicker.

### i18n

Verify the Arabic "المحادثة غير موجودة" lives at a next-intl key (e.g. `errors.chatNotFound`). Once both fixes land it should rarely surface — but if it does (user deleted a thread in another tab), the wording stays correct.

---

## Files modified (summary)

### Frontend (`E:\client-projects\hallha-front-end`)

| Path | Change |
|---|---|
| `messages/en.json`, `messages/ar.json` | Add `app.clients`, `app.clientDetail`, `app.nav`, `app.theme` namespaces |
| `app/(dashboard)/clients/page.tsx` | i18n sweep + card grid + skeleton |
| `app/(dashboard)/clients/[clientId]/page.tsx` | i18n sweep + two-column layout + extract uploader |
| `app/(dashboard)/clients/[clientId]/chat/page.tsx` | i18n sweep + breadcrumb |
| `components/clients/document-uploader.tsx` (NEW) | Drag-drop, multi-file, per-row progress, polling |
| `components/app-sidebar.tsx` | Real menu (Dashboard / Chats / Clients), drop placeholder data |
| `components/nav-user.tsx` | Theme submenu (Light / Dark / System) |
| `components/theme-toggle.tsx` (NEW) | Compact sun/moon icon button for sidebar footer |
| `lib/nav.ts` (NEW) | Nav config consumed by sidebar |
| `lib/api/queries/clients.ts` | `uploadClientDocument` returns `{documentId, statusUrl}`; new `useDocumentStatusQuery` polling hook |
| `lib/api/queries/chats.ts` | Handle AbortError: skip refetch, write optimistic cache |
| `lib/stores/chat.ts` | Preserve `lastAbortedSnapshot` on abort |
| `package.json` | + `react-dropzone` |

### Backend (`E:\client-projects\hallha-node`)

| Path | Change |
|---|---|
| `src/routes/clients.ts` | Split upload into transport (202) + async ingest; add status endpoint; add DELETE for pending docs |
| `src/routes/chat-audit.ts` | Move `recordThreadActivity` to before stream start |
| `src/lib/ingest-recovery.ts` (NEW) | Boot-time janitor for stale `pending` documents |
| `src/index.ts` | Pre-warm embedding pipeline; raise `server.requestTimeout`/`headersTimeout`; call ingest janitor |
| `CLAUDE.md`, `src/routes/CLAUDE.md`, `HALLHA_INTEGRATION.md` | Document async upload pattern + status endpoint contract |

## Reused (do not reinvent)

- `components/ui/{card,dialog,dropdown-menu,breadcrumb,skeleton,tabs,progress}.tsx` — all shadcn already present.
- `components/theme-provider.tsx` + `next-themes` `useTheme()` — toggle wires into existing provider.
- `components/ui/direction.tsx` — RTL already handled per locale.
- `src/rag/ingest.ts` `ingestPdfToPinecone()` — reused unchanged by the new async wrapper.
- `src/lib/embeddings.ts` `getEmbeddings()` — pre-warmed but otherwise untouched (deny-listed).
- React Query keys in `lib/api/queries/clients.ts` — extend with `status(documentId)` key for polling.

## Verification

1. `pnpm typecheck` + `pnpm lint` clean in both repos.
2. **i18n sweep:** switch locale cookie to `en` and to `ar`, walk through `/clients`, `/clients/[id]`, `/clients/[id]/chat`, sidebar, user menu — no English literals visible in Arabic mode; layout flips RTL correctly.
3. **Theme toggle:** click Light / Dark / System in user dropdown; click sun/moon in sidebar footer; refresh page — choice persists (next-themes cookie/localStorage).
4. **Sidebar nav:** "Clients" entry visible and active when at `/clients/**`. Chat empty-state shows "Audit a client" link.
5. **Upload UX (local):** drop a PDF, see progress 0→100, then "Processing…", then "Ready" once polling resolves. Drop 3 PDFs → uploaded serially → all end "Ready". Cancel mid-upload → row removed, no orphan in DB.
6. **Upload 504 (prod):** deploy backend with pre-warm + async ingest, deploy frontend, upload a 2-page PDF in production — POST returns 202 in < 2 s, status polls flip to `ready` within seconds. Then upload a 50-page PDF — POST still returns 202 in < 2 s, status takes longer but never 504. Confirm with DevTools network tab.
7. **Stop-chat:** start a chat, hit Stop mid-stream — no "Chat not found" toast; the partial assistant message stays visible; sidebar shows the thread; refresh the page → thread still loads with the partial message. Repeat for a brand-new thread (no prior history) to cover the original failure case.
8. Existing Vitest + Playwright (if any) suites still pass.

Once all four pieces verify, copy this plan markdown to both `E:\client-projects\hallha-front-end\PLAN_clients_ux_upload_stop.md` and `E:\client-projects\hallha-node\PLAN_upload_async_chat_abort.md` per the project-root plan convention before implementation begins.
