# Hallha (Node.js)

A Sharia compliance auditor — Node.js/Express/TypeScript port of the original Python/FastAPI service. Users upload Islamic finance documents (contracts, statements) and chat with a LangGraph agent that audits them against a Sharia knowledge base stored in Pinecone. Conversation memory persists in MongoDB.

## Stack

- **Express 5** + **TypeScript** (NodeNext, strict)
- **LangGraph.js** with **MongoDB checkpointer** for thread-level memory
- **Groq** LLMs via `@langchain/groq` (`GROQ_MODEL`, default `llama-3.3-70b-versatile`)
- **Pinecone** vector store via `@langchain/pinecone`
- Local **HuggingFace Transformers.js** embeddings (`Xenova/all-MiniLM-L6-v2`, 384 dims) — same model the Python service uses, so the existing Pinecone `hallha` index is reused with **no re-ingest**
- **Vitest** + **supertest** for tests, **ESLint** + **Prettier** for code quality
- **LangSmith** auto-traced when `LANGSMITH_*` env vars are set

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- A Pinecone index named `hallha` with dimension **384** and metric `cosine`
- A MongoDB connection string

## Setup

```bash
pnpm install
cp .env.example .env
# fill in keys: GROQ_API_KEY, PINECONE_API_KEY, MONGO_URI
pnpm dev
```

The server boots on `http://localhost:8000`.

## Endpoints

### `POST /upload-knowledge`

Multipart with field `file` (PDF). Chunks the document (1800 chars, 150 overlap) and upserts into Pinecone.

```bash
curl -F "file=@data/sharia_rulebook.pdf" http://localhost:8000/upload-knowledge
```

### `POST /chat-audit`

Multipart fields:
- `thread_id` *(required)* — session identifier; the agent's memory is keyed on this
- `message` *(optional)* — the user's question
- `file` *(optional)* — a PDF or text file to audit (its text is read in-memory, not persisted)

```bash
curl -F "thread_id=t1" -F "message=Is a 5% APR student loan permissible?" http://localhost:8000/chat-audit
curl -F "thread_id=t1" -F "file=@sample-contract.pdf" http://localhost:8000/chat-audit
```

## Scripts

- `pnpm dev` — watch mode via `tsx`
- `pnpm build` — emit `dist/` via `tsc`
- `pnpm start` — run the built server
- `pnpm test` — Vitest smoke tests
- `pnpm lint` / `pnpm format` — ESLint / Prettier

## Notes on parity with the Python version

- Same Pinecone index name (`hallha`), embedding model, and chunk parameters → existing knowledge is reusable.
- Same retriever k=4 and system prompt intent; audit LLMs differ (Python often uses Gemini; Node uses **`GROQ_MODEL`** via Groq).
- **Mongo checkpoint format is not interchangeable between LangGraph Python and JS.** Defaults use `checkpoints_langgraph_js` / `checkpoint_writes_langgraph_js` so you can share a cluster with Python safely.
- First boot downloads the embedding model (~90MB) into the local cache. Subsequent boots are instant.
