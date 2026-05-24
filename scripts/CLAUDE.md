# scripts/ — One-shot utilities

| Script | Command | Purpose |
|---|---|---|
| `seed-superadmin.ts` | `pnpm seed:admin` | Idempotent — creates one superadmin via Better-Auth `signUpEmail`, then patches `role: 'superadmin', emailVerified: true`. Requires `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` in `.env`. Safe to re-run. |
| `backfill-knowledge-files.ts` | `pnpm backfill:knowledge-files` | Migrate/reconstruct `knowledge_files` collection metadata. Run after schema or ingest-pipeline changes that affect metadata shape. |
| `dev-auth-smoke.ts` | `pnpm dev:auth-smoke` | Manual signup → login → session probe. Use when debugging cookie/CORS issues during development. |

All scripts run via `tsx` (no compilation step) and use the same lazy singletons as the server, so they pick up `.env` automatically. They share the same `process.exit(1)`-on-env-failure behavior — fix `.env` first if a script bails before logging anything.
