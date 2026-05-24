# src/middleware

## Error mapper (`error.ts`)

Precedence (first match wins):

1. `HttpError` → its `status` + message.
2. `IngestError` → 400 + message.
3. Upstream LLM error (recognized by `parseUpstreamLlmError`):
   - quota/rate-limit → 429 with `Retry-After` header and `{ kind, provider, retryAfterSeconds }` in body.
   - other upstream → 502.
4. Better-Auth `APIError` → its status.
5. Anything else → 500 (logged at `error` level).

**Throw, don't return.** Routes/nodes should throw; never call `res.status(...).json(...)` for errors. The mapper sets a consistent JSON shape `{ detail, kind?, provider?, retryAfterSeconds? }`.

## Auth (`require-auth.ts`, `require-admin.ts`)

- `requireAuth` — reads Better-Auth session cookie, populates `req.user` and `req.activeOrgId`. 401 if no session.
- `requireAdmin` — composes `requireAuth` + `role === 'admin' || 'superadmin'`. 403 otherwise.
- `requireSuperadmin` — composes `requireAuth` + `role === 'superadmin'`. Used for role/ban mutations only.

## Uploads (`upload.ts`)

Three multer instances:

- `memoryUpload` — in-memory buffer, ≤ plan limits. Used for chat-audit (`file`) so PDFs aren't persisted to disk.
- `voiceUpload` — in-memory buffer for `/chat-audit/transcribe` (`audio`).
- `diskUpload` — writes to `./uploads/<originalname>` for `/upload-knowledge` (ingest pipeline reads from disk).

## Rate limit (`rate-limit.ts`)

Separate per-tier limiters: `chatAuditMinuteLimiter` + `chatAuditHourlyLimiter`, `transcribeMinuteLimiter` + `transcribeHourlyLimiter`, upload limiter. Keyed by authenticated user id where possible, else IP. Returns 429 + standard `Retry-After`.

## Usage limit (`usage-limit.ts`)

`usageLimitAudit()` reads the user's plan (`getPlan(planKey)`) and current month's audit count. Sets `res.locals.planState` so downstream handlers can read `maxDocPages` etc. Throws `HttpError(402, ...)` when exceeded.
