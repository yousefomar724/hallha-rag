# scripts/ — One-shot utilities

| Script | Command | Purpose |
|---|---|---|
| `seed-superadmin.ts` | `pnpm seed:admin [email]` | Idempotent. Accepts the target email as a CLI arg (`pnpm seed:admin user@example.com`); falls back to `SEED_ADMIN_EMAIL` in `.env`. **Promoting an existing user only needs the email** — no password required. Creating a new user also requires `SEED_ADMIN_PASSWORD`. Patches `role: 'superadmin', emailVerified: true`. Safe to re-run. |
| `backfill-knowledge-files.ts` | `pnpm backfill:knowledge-files` | Migrate/reconstruct `knowledge_files` collection metadata. Run after schema or ingest-pipeline changes that affect metadata shape. |
| `dev-auth-smoke.ts` | `pnpm dev:auth-smoke` | Manual signup → login → session probe. Use when debugging cookie/CORS issues during development. |

All scripts run via `tsx` (no compilation step) and use the same lazy singletons as the server, so they pick up `.env` automatically. They share the same `process.exit(1)`-on-env-failure behavior — fix `.env` first if a script bails before logging anything.
