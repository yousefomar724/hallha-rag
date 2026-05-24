# admin/ — Platform admin SPA

Vite + React 19 + shadcn/ui + Tailwind 4. Workspace sibling package (pnpm). Run with `pnpm dev:admin` (port 5173) from the repo root.

## Stack

- **React 19** — function components only, no `forwardRef`.
- **Routing** — `react-router-dom` v7. Routes defined in `src/App.tsx`.
- **Auth** — `better-auth/react` with the `adminClient` plugin (`src/lib/auth-client.ts`). `useSession()` for session state.
- **Data** — TanStack Query (React Query) v5. Server state only; no Redux/Zustand.
- **HTTP** — `src/lib/api.ts` fetch wrapper. Talks to the same backend as the main app (default `http://localhost:8000`, env `VITE_API_URL`).
- **UI** — shadcn/ui primitives in `src/components/ui/`. Add via `npx shadcn@latest add <name>` from the `admin/` dir.
- **Toasts** — Sonner.

## Routes

| Path | Component |
|---|---|
| `/login` | `LoginPage` |
| `/` | `DashboardPage` — platform stats (`GET /admin/stats`). |
| `/organizations` | `OrganizationsPage` — list + plan/usage. |
| `/organizations/:id` | `OrganizationDetailPage` — members + recent chats. |
| `/users` | `UsersPage` — list, role/ban mutations (superadmin only). |
| `/knowledge` | `KnowledgePage` — PDF upload → `POST /upload-knowledge`. |
| `/audited-clients`, `/audited-clients/:id` | `AuditedClientsPage` / `AuditedClientDetailPage`. |

All routes except `/login` wrap in `ProtectedRoute` (`src/routes/ProtectedRoute.tsx`), which redirects to `/login` if no session.

## Layout

`AppShell` (`src/components/AppShell.tsx`) is the standard layout — sidebar nav + header + `<Outlet />`. Pages shouldn't re-render their own header/sidebar.

## Env

`admin/.env`:
```
VITE_API_URL=http://localhost:8000
```
