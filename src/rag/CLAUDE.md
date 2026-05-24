# src/rag — PDF → Pinecone ingestion

## Pipeline

1. PDF buffer arrives via `/upload-knowledge` (admin) or client-documents upload.
2. `extractPdfMarkdown` (`utils/pdf-to-markdown.ts`) → `@opendocsg/pdf2md` converts PDF to Markdown using font-size heuristics (`#`/`##`/`###`).
3. `splitMarkdownByHeadings` (`utils/markdown-header-splitter.ts`) splits on heading boundaries, preserving a `headings` breadcrumb (e.g. `"Chapter II > Article 5 — Riba"`).
4. Sections that exceed 1800 chars fall back to `RecursiveCharacterTextSplitter` (1800/150).
5. `getEmbeddings()` (HF Transformers, 384-dim) embeds each chunk.
6. `getPineconeIndex().namespace(ns).upsert(...)` writes to the chosen namespace.

## Namespaces

- **Global** (`__default__`): AAOIFI standards uploaded via admin `/upload-knowledge`.
- **Per-client tenant** (`client_tenant_:{clientId}`): documents uploaded for a specific audited client.

Retrieval queries both and merges, so the LLM sees global rules plus client-specific evidence.

## Chunk metadata

Each upserted vector carries:

- `text` — chunk text
- `source` — original filename
- `page` — page number(s)
- `headings` — Markdown heading breadcrumb (Node-ingested chunks only)
- `s3Key`, `s3Url` — back-pointer for citations / re-download
- `standard_number` — parsed AAOIFI number (e.g. `"FAS 4"`) when detected via `utils/standard-number.ts`
- `firm`, `client`, `clientId` — tenant tags when applicable

## Cross-runtime parity

- **Vectors are compatible** with the Python service (same embedder, same dimensions).
- **Chunk shape differs.** Python uses size-based 1800/150 splitting without heading metadata. Node chunks carry the `headings` field; Python chunks don't. Retrieval mixes both transparently, but be aware when debugging citations.

## Errors

Throw `IngestError(message)` from `ingestPdfToPinecone` for any user-facing failure (bad PDF, empty after parse, etc.). The error mapper turns it into 400. `delete-knowledge.ts` removes vectors by metadata filter.
