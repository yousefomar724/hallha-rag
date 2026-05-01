# Improve RAG Chunking — Markdown / Heading-Aware Splitting

## Context

Sharia / financial legal PDFs are dense and structurally numbered (Article 1, Article 2, Chapter II, …). The current pipeline (`src/rag/ingest.ts:52`) extracts plain text with `unpdf` and splits with `RecursiveCharacterTextSplitter` at 1800 chars / 150 overlap — a size-based cut that routinely slices through clauses. When `retrieveShariaRules` (`src/agent/nodes.ts:60`) pulls `k=4` chunks, the LLM frequently sees half an article and either hallucinates the missing half or audits incompletely.

**Goal:** Convert each PDF to Markdown (font-size heuristics → `#`/`##`/`###`), then split primarily on heading boundaries so each chunk is one coherent legal clause. Fall back to size-based splitting only for sections that exceed the embedding-friendly window. Preserve heading path + page in chunk metadata so citations get richer.

**Non-goals (confirmed with user):**
- Re-ingest of existing Pinecone data — new uploads only; old chunks stay until manually re-uploaded.
- Embedding model / index changes — keep `Xenova/all-MiniLM-L6-v2`, 384-dim, index `hallha`. Vector-level parity with the Python service is preserved.
- Updating the Python service in lockstep — Node will diverge on chunking; we'll document it.

## Approach

```
PDF buffer
  → @opendocsg/pdf2md (font-size → markdown, page markers injected)
  → custom MarkdownHeaderSplitter (split on #/##/###, track heading path)
  → fallback RecursiveCharacterTextSplitter for any section > 1800 chars
  → existing getEmbeddings() (unchanged)
  → existing Pinecone upsert (+ new `headings` metadata field)
```

`@langchain/textsplitters@1.0.1` does **not** export `MarkdownHeaderTextSplitter` (only `MarkdownTextSplitter`, which is recursive-char with `#` as one of many separators). We write a small custom splitter (~80 LoC) — simpler and lighter than pulling in the umbrella `langchain` package.

## Files

### New

**`src/utils/pdf-to-markdown.ts`**
Thin wrapper around `@opendocsg/pdf2md`. Signature: `extractPdfMarkdown(buffer: Uint8Array): Promise<{ markdown: string; pageCount: number }>`. Uses `pdf2md`'s per-page callback to inject `<!-- page: N -->` HTML comments between pages so the splitter can attribute chunks to source pages. Throws `IngestError` on empty / unparseable output (parallels `extractPdfText`).

**`src/utils/markdown-header-splitter.ts`**
Custom splitter. Public function `splitMarkdownByHeadings(markdown: string, opts: { source: string; s3Key: string; s3Url: string; organizationId: string; maxChars?: number; overlap?: number }): Promise<Document[]>`.

Logic:
1. Walk the markdown line by line. Maintain a heading stack `[h1, h2, h3]`. On `^(#{1,3}) (.+)$` update the stack (truncate deeper levels).
2. On `<!-- page: N -->` lines, update `currentPage`.
3. Accumulate body lines under the current heading path; emit a `Document` when the heading path changes (or at EOF).
4. `metadata.headings` = `"H1 > H2 > H3"`; `metadata.page` = the page where the section started.
5. **Fallback:** any emitted chunk over `maxChars` (default 1800) is fed through the existing `RecursiveCharacterTextSplitter` with `chunkOverlap: 150`; the resulting sub-chunks inherit the parent's `headings`/`page` metadata.
6. Drop chunks whose trimmed text is empty (matches existing filter at `src/rag/ingest.ts:58`).

**`tests/markdown-header-splitter.test.ts`** — Vitest unit tests with fixture strings:
- Splits at `##` boundaries; each chunk has the right heading path.
- Nested `# > ## > ###` produces `"H1 > H2 > H3"`.
- `<!-- page: N -->` markers populate `metadata.page` on the right chunk.
- A 5000-char section is further chunked with overlap; sub-chunks share headings.
- Markdown with no headings falls through to a single oversized fallback chunk (then size-split).

### Modified

**`src/rag/ingest.ts`**
- Swap `extractPdfText` (`line 34`) → `extractPdfMarkdown`. Remove the per-page `Document` construction (`lines 44–50`).
- Swap the `RecursiveCharacterTextSplitter` block (`lines 52–56`) → `await splitMarkdownByHeadings(markdown, { source, s3Key, s3Url, organizationId })`.
- In the upsert metadata builder (`lines 100–111`) add `headings: (meta.headings as string | undefined) ?? ''`.
- Keep all existing `IngestError` paths and the empty-chunk filter.
- Keep the `logger.info` line — `pageCount` now comes from the converter's return.

**`src/agent/nodes.ts`** — `retrieveShariaRules` (`lines 59–93`)
- Pull `headings` out of `d.metadata` alongside `source`/`page`/`s3Url`.
- Thread `headings` into each `RetrievedSource`.
- Update the `context` block (`lines 85–90`) so each entry reads `[${id}] ${source} — ${headings}, p. ${page}\n${chunk}` (omit the `— ${headings}` segment if empty, to stay graceful for legacy chunks).

**`src/agent/prompt.ts`**
- Add optional `headings?: string` to `RetrievedSource`.
- Render it in the system-prompt source list (same omit-if-empty rule).

**`package.json`**
- Add `@opendocsg/pdf2md` to `dependencies`. Run `pnpm install` so `pnpm-lock.yaml` updates.

**`CLAUDE.md`** — Cross-runtime parity section
- Add a note: "Node uses heading-aware chunking via `@opendocsg/pdf2md` + a custom Markdown header splitter; the Python service still uses size-based 1800/150 splitting. Vector-level compatibility is preserved (same 384-dim embedder, same index), but the *shape* of retrieved chunks differs across runtimes — chunks ingested by Node carry a `headings` metadata field that Python-ingested chunks do not."

## Reused, do not re-implement

- `getEmbeddings()` — `src/lib/embeddings.ts` (unchanged).
- `getPineconeClient()` / `getRetriever()` — `src/lib/pinecone.ts` (unchanged).
- `IngestError` — `src/rag/ingest.ts:10` (re-thrown from new utility).
- `RecursiveCharacterTextSplitter` from `@langchain/textsplitters` — used as the *fallback* inside the new splitter; same 1800/150 params so a lone oversized section still respects the embedding window.
- Multer memory upload + S3 upload + plan/auth gating in `src/routes/upload-knowledge.ts` — unchanged. Route behavior is identical from the client's perspective.

## Tests

- `pnpm test tests/markdown-header-splitter.test.ts` — new unit tests above.
- `pnpm test tests/upload-knowledge.test.ts` — should still pass unchanged (it mocks `ingestPdfToPinecone`).
- `pnpm test tests/chat-audit.test.ts` — should still pass; if it asserts the exact `[id] source, p. N` format of context, update the expected string to allow the new optional `— headings` segment.
- `pnpm typecheck`.

## Verification (manual end-to-end)

Requires `.env` with real `GROQ_API_KEY`, `PINECONE_API_KEY`, `MONGO_URI`, `AWS_*`.

1. `pnpm dev` (API on :8000) and `pnpm dev:admin` (SPA on :5173).
2. Log in as superadmin, upload a real Sharia rulebook PDF on the Knowledge page.
3. In server logs, confirm `"Ingesting PDF chunks"` shows a `chunkCount` near the number of articles in the PDF (typically *fewer* chunks than the old size-based run on the same file, because natural sections beat 1800-char windows).
4. Inspect one upserted vector in the Pinecone console — confirm `metadata.headings` is populated (e.g. `"Chapter II > Article 5 — Riba"`) and `metadata.page` is plausible.
5. POST to `/chat-audit` with a question targeting a known article. Confirm the assistant cites that article and that the rendered source list now includes the heading path.
6. **Regression**: upload a flat / un-structured PDF (no detectable headings). Confirm the splitter falls back to size-based chunking and ingest still returns success — proves the fallback path works.
7. **Negative**: upload a non-PDF or corrupted PDF — confirm `IngestError` → HTTP 400 still maps correctly via `src/middleware/error.ts`.

## Risk notes

- `@opendocsg/pdf2md` heading detection is heuristic (font size). Scanned / image-based PDFs will have no heading info — fallback handles this but quality matches the old pipeline.
- `pdf2md` is pure JS but pulls `pdfjs-dist`, which the codebase already loads via `unpdf`. Bundle impact is small but not zero. We keep `unpdf` in place because `extractPdfText` may still be used elsewhere — verify with a grep before removing.
- Heading paths from Arabic-language PDFs may render with mixed RTL/LTR. The metadata is stored as raw UTF-8 and only displayed in citations; no special handling needed unless the LLM mis-renders it (unlikely for Groq Llama 3.3).
