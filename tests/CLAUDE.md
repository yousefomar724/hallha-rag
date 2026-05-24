# tests — Vitest

## Setup

`vitest.config.ts` injects fake `GROQ_API_KEY`, `GOOGLE_API_KEY`, `PINECONE_API_KEY`, `MONGO_URI` so tests don't need `.env`. Tests are excluded from `tsc` (`tsconfig.json` excludes `tests/`); Vitest does its own typechecking at runtime.

## Discipline

- **Mock at the module boundary.** Never hit real LLM, Pinecone, S3, or external Mongo. Use `vi.mock('@/lib/llm.js', ...)` style at the top of each test file.
- **Import `createApp` from `src/app.ts`** — never spin up `src/index.ts`. `createApp` returns the Express app without binding a port, which Supertest mounts directly.
- **Use the auth helpers.** `tests/test-helpers/auth-flow.ts` exports `createUserWithSessionCookie()` and `getPrimaryOrgIdForUser()`. Don't reinvent the session-cookie dance in each test.

## Patterns

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

vi.mock('../src/agent/graph.js', () => ({
  getCompiledGraph: vi.fn().mockResolvedValue({
    invoke: vi.fn().mockResolvedValue({ messages: [/* ... */], sources: [] }),
    streamEvents: vi.fn(),
    getState: vi.fn(),
  }),
  getEphemeralGraph: vi.fn(),
}));

// then: const app = createApp(); await request(app).post('/chat-audit')...
```

## Coverage

- Auth, chat-audit JSON + streaming, client-scoped retrieval, voice transcription, chat history CRUD + purge, client/document routes, greeting & guardrail nodes (three variants), markdown header splitter, standard-number parsing, retrieval merge, org-profile schema, knowledge-file metadata, upload-knowledge ingest flow, web search tool.

Run one file: `pnpm test tests/chat-audit.test.ts`. One test: `pnpm test -t "rejects missing thread_id"`.
