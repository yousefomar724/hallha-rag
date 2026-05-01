# Admin Panel + Knowledge Ingestion Re-Gating

## Context

`/upload-knowledge` is currently gated by **plan tier** (`requireCustomKnowledgePlan` allows only `business` / `enterprise` orgs — `src/middleware/usage-limit.ts:69-91`). The product has shifted: knowledge ingestion is no longer a self-service per-org feature — it is a **platform-curated capability** performed by Hallha staff. This plan re-gates `/upload-knowledge` to admin-only and adds a small admin panel for staff to:

1. Upload PDFs to the shared Pinecone knowledge base.
2. See platform health: counts of users / orgs, plan distribution, audit usage, top orgs by activity.
3. Manage users (set role, ban/unban) — provided out-of-the-box by the Better-Auth admin plugin.

There is already a public-user-facing frontend (landing + chat) in a separate project. **Recommendation: build a dedicated `admin/` Vite + React + shadcn SPA inside this backend repo, deployed at an `admin.` subdomain.** Reasons:

- Keeps admin code/role logic out of the public bundle (smaller attack surface, smaller bundle).
- Independent release cadence — staff tooling won't be blocked on user-facing releases.
- Better-Auth sessions are cookie-based; with `trustedOrigins` configured for both subdomains, the same auth instance serves both apps. No duplicate auth.
- Smaller dependency surface (admin app doesn't need the public-side runtime).

If the existing user frontend grows admin views later, pulling them out of the SPA into the public app is straightforward; going the other direction (extracting admin from a coupled bundle) is harder. Starting separate is the cheaper bet.

---

## Backend

### 1. Add Better-Auth admin plugin
**File:** `src/lib/auth.ts`

- Import `admin` from `better-auth/plugins` and add to `plugins: [...]`.
- Configure: `defaultRole: 'user'`, `adminRoles: ['admin', 'superadmin']`. The plugin auto-extends the `user` schema with `role` (string) and `banned` / `banReason` / `banExpires` fields, and exposes `/api/auth/admin/*` endpoints (`listUsers`, `setRole`, `banUser`, `unbanUser`, `impersonateUser`, `removeUser`).
- Re-run / restart will let better-auth migrate existing user docs (default role applied lazily).

### 2. Superadmin seeder
**New file:** `scripts/seed-superadmin.ts`

- Reads `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from `.env` (validate via Zod alongside existing `config/env.ts` — but make these optional so prod boot doesn't require them).
- Idempotent: query `user` collection by email; if missing, call `auth.api.signUpEmail`; then `db.collection('user').updateOne({ email }, { $set: { role: 'superadmin', emailVerified: true } })`.
- Add npm script `"seed:admin": "tsx scripts/seed-superadmin.ts"` in `package.json`.
- Document in `CLAUDE.md` under a new "Seeding" section.

### 3. Admin authorization middleware
**New file:** `src/middleware/require-admin.ts`

- Composes on top of `requireAuth` (`src/middleware/require-auth.ts`). After auth runs, look up the user doc fresh from Mongo (or rely on session-attached role if the admin plugin populates it — verify), and throw `HttpError(403, 'Admin access required.')` unless `role` is `admin` or `superadmin`.
- Export both `requireAdmin` and `requireSuperadmin` (the latter for destructive ops like role changes).

### 4. Re-gate `/upload-knowledge`
**File:** `src/routes/upload-knowledge.ts:15-20`

- **Remove** `requireCustomKnowledgePlan` from the chain.
- **Replace** with `requireAdmin`.
- Drop or keep rate-limiters? Recommend keeping the daily limiter only as a safety rail; remove the per-minute limiter (admins won't bulk-upload that fast).
- The existing route URL stays the same (`POST /upload-knowledge`) for backwards compatibility, but is now restricted.

**File:** `src/middleware/usage-limit.ts:68-91`

- `requireCustomKnowledgePlan` and `canUploadCustomKnowledge` (`src/lib/plans.ts`) become unused. Delete the middleware export and the helper. Drop the `customKnowledgeBase` flag from the `PlanLimits` type and from each tier definition — orgs no longer get this feature regardless of plan, so leaving it lying around as dead config is misleading. Search the repo for residual references to that flag.

### 5. Admin metrics + management routes
**New file:** `src/routes/admin.ts`

All routes require `requireAdmin` (the role-set ones require `requireSuperadmin`):

| Method | Path | Handler logic |
|---|---|---|
| GET | `/admin/stats` | One aggregate response: `{ users: {total, last30d}, organizations: {total, byPlan: {free, starter, business, enterprise}, onboardingCompleted}, audits: {currentPeriodTotal, last30d}, knowledgeChunks: <pinecone index stats vector count> }` |
| GET | `/admin/organizations?limit&cursor&plan&search` | Paginated list. Project: `_id`, `name`, `plan`, `planStatus`, `usageAuditsThisPeriod`, `onboardingCompleted`, `createdAt`. Cursor-based on `_id`. |
| GET | `/admin/organizations/:id` | Org doc + member count + last 5 chat threads (from `chat_thread` collection). |
| GET | `/admin/users?limit&cursor&search&role` | Wraps better-auth's listUsers OR raw query on `user` collection with org membership joined. |
| POST | `/admin/users/:id/role` | Superadmin only. Calls `auth.api.setRole`. |
| POST | `/admin/users/:id/ban` / `/unban` | Calls better-auth admin plugin equivalents. |

Stats handler uses raw MongoDB aggregation against `user`, `organization`, `chat_thread`. For "knowledgeChunks", call Pinecone `index.describeIndexStats()` (`src/lib/pinecone.ts` already exposes the client).

**File:** `src/app.ts` — mount `adminRouter` after existing routes.

### 6. CORS + trusted origins
**File:** `src/lib/auth.ts` and the CORS setup in `src/app.ts`

- Add the admin frontend origin (e.g. `ADMIN_ORIGIN` env, default `http://localhost:5173`) to `auth.trustedOrigins` and to the CORS `origin` allowlist.

---

## Frontend (`admin/` SPA)

**Stack:** Vite + React + TypeScript + shadcn/ui + Tailwind + React Router + TanStack Query + better-auth React client.

**Layout:**

```
admin/
  package.json (own pnpm workspace member)
  vite.config.ts
  tailwind.config.ts
  src/
    main.tsx
    App.tsx
    lib/auth-client.ts        # createAuthClient + adminClient plugin
    lib/api.ts                # fetch helper, sends credentials
    components/ui/...         # shadcn components
    components/AppShell.tsx   # sidebar + topbar
    pages/
      LoginPage.tsx
      DashboardPage.tsx       # stats cards + plan distribution
      OrganizationsPage.tsx   # table + filters
      OrganizationDetailPage.tsx
      UsersPage.tsx           # table; row actions: set role, ban
      KnowledgePage.tsx       # PDF dropzone -> POST /upload-knowledge
    routes/ProtectedRoute.tsx # redirects to /login if not admin
```

Convert this repo to a small pnpm workspace (`pnpm-workspace.yaml` listing `.` and `admin`). Backend `package.json` stays the root. Add `pnpm dev:admin` and `pnpm build:admin` scripts at root. Optionally have `pnpm dev` run both via `concurrently` or leave them separate.

**Auth:** `createAuthClient({ baseURL, plugins: [adminClient()] })`. Login page calls `signIn.email`. `ProtectedRoute` checks `useSession()` and the user's role; non-admins are signed out.

**UI:** shadcn primitives only — `Card`, `Table`, `Badge`, `Button`, `Input`, `Dialog`, `DropdownMenu`, `Sonner` for toasts. Aim for visually-clean but not over-designed; staff tool, not customer surface.

---

## Critical files

**Modify:**
- `src/lib/auth.ts` — add admin plugin, trustedOrigins
- `src/app.ts` — mount admin router, update CORS
- `src/routes/upload-knowledge.ts` — swap plan gate for admin gate
- `src/middleware/usage-limit.ts` — remove `requireCustomKnowledgePlan`
- `src/lib/plans.ts` — drop `customKnowledgeBase`
- `src/config/env.ts` — add `ADMIN_ORIGIN`, optional `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
- `package.json` + new `pnpm-workspace.yaml` — workspace setup, scripts
- `CLAUDE.md` — document admin role, seeder, admin routes, workspace

**Create:**
- `src/middleware/require-admin.ts`
- `src/routes/admin.ts`
- `scripts/seed-superadmin.ts`
- `admin/` (entire Vite + shadcn app)

## Reuse

- `requireAuth` middleware (`src/middleware/require-auth.ts`) — compose, don't duplicate.
- `HttpError` (`src/lib/errors.ts`) — throw 403/404 from admin handlers.
- Existing PDF ingestion path (`src/rag/ingest.ts`) — admin upload uses unchanged.
- Pinecone singleton (`src/lib/pinecone.ts`) — for `describeIndexStats` in metrics.
- MongoDB singleton (`src/lib/mongo.ts`) — for stats aggregations.
- Existing rate-limit factory (`src/middleware/rate-limit.ts`) — apply a relaxed admin limiter.

## Verification

1. **Seeder:** `pnpm seed:admin` — confirm `db.user.findOne({ email })` shows `role: 'superadmin'`. Re-run; should be a no-op.
2. **Admin gate:** `curl -F file=@x.pdf /upload-knowledge` with a regular user cookie → 403; with seeded superadmin cookie → 200.
3. **Stats:** `GET /admin/stats` returns expected shape; cross-check counts manually with `mongosh`.
4. **Better-Auth admin endpoints:** `POST /api/auth/admin/list-users` works for admin, 403 for user.
5. **Frontend:** `pnpm dev` (backend) + `pnpm dev:admin` (frontend); log in as superadmin → dashboard renders; log in as regular user → blocked at `ProtectedRoute`.
6. **Tests:** Add `tests/admin-routes.test.ts` (Vitest) mocking `requireAuth` + DB calls — covers 403 for non-admin, 200 + shape for admin on `/admin/stats` and `/upload-knowledge` re-gate.
7. **Typecheck + lint:** `pnpm typecheck && pnpm lint` clean across backend; `pnpm --filter admin build` clean.
