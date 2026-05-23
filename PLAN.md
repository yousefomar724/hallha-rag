# Hallha — Landing Repositioning, Gemini Migration, RAG Citation Upgrade

## Context

We are executing three coordinated updates across the Hallha (حللّها) Sharia auditing platform:

1. **Repositioning** — the platform's narrative shifts from "every Muslim founder deserves Sharia tools" (SMB/founder) to a B2B tool sold to **Sharia Audit Firms** that use Hallha to audit their own clients. Multi-tenant firm/client plumbing already exists on the backend; this is principally a marketing rewrite.
2. **Provider migration** — replace Groq-hosted Llama models with Google `gemini-2.0-flash` via `@langchain/google-genai`. Whisper transcription stays on Groq for now (user choice).
3. **RAG citation discipline** — extend the audit system prompt so every violation surfaces a structured block with Violation Description, AAOIFI Standard Reference, Location (page + section), and Solution / Purification (التطهير). The ingestion pipeline already attaches `page`, `source`, `standard_number`, and `headings` metadata to each Pinecone chunk — the work is exposing those fields cleanly to the LLM and tightening the prompt.

Why this matters: the platform is being repositioned commercially toward audit firms (who buy in larger contracts than individual founders), and those firms need defensible, location-precise citations in their deliverables. The Gemini swap reduces dependence on a single inference provider and removes the llama-3.3-70b 6k context ceiling we're brushing against on large contract audits.

---

## Part 1 — Landing repositioning (frontend)

**Repo:** `E:\client-projects\hallha-front-end`

### Files to edit
- `messages/ar.json` — full rewrite of the `landing.*` subtree
- `messages/en.json` — full rewrite of the `landing.*` subtree
- `app/(landing)/page.tsx` — metadata only, no structural changes
- Component files (no logic changes — they already read every key via `useTranslations`):
  - `components/landing/hero-section.tsx`
  - `components/landing/about-section.tsx`
  - `components/landing/features-section.tsx`
  - `components/landing/pricing-section.tsx`
  - `components/landing/faq-section.tsx`
  - `components/landing/contact-section.tsx`
  - `components/landing/stats-banner.tsx`

The component tree, key paths (e.g. `landing.hero.title`, `landing.features.items.auditor.title`), and `t(...)` call sites stay the same. Only message values change. This keeps the diff to the two JSON files plus a tiny metadata tweak.

### Key copy direction (audience: Sharia Audit Firms)

- **Arabic Hero Title:** `حللّها: المساعد الذكي للتدقيق الشرعي الرقمي`
- **Arabic Hero Subtitle:** `أتمتة مراجعة العقود بمعايير AAOIFI`
- **English Hero Title:** `Hallha — the AI co-auditor for Sharia audit firms`
- **English Hero Subtitle:** `Automate AAOIFI-grade contract review.`
- Anchor points to weave throughout: **precision**, **70% faster audits**, **AAOIFI-grade compliance**, **defensible citations**, **firm + client workspace**.

### Section-by-section copy retargeting

| Section | Old framing | New framing (firm-targeted) |
|---|---|---|
| Hero pill | "AI-powered Islamic finance" | "Built for Sharia audit firms" / "صُمِّمت لشركات التدقيق الشرعي" |
| Hero CTAs | "Start your free audit" | "Book a firm demo" + "See a sample audit report" |
| Stats banner (8 items) | Generic SMB stats | Firm-relevant: avg audit cycle cut, AAOIFI standards indexed, average pages per contract, citations per report |
| About / Mission | "Every Muslim founder deserves…" | "Sharia audit firms deserve tooling that matches the rigor their scholars demand. Hallha is the AI co-auditor that turns a multi-week contract review into a one-day, fully-cited deliverable." |
| About stats grid | Users / Compliance% / Countries / Transactions | Firms onboarded / AAOIFI standards in index / Avg time saved / Citations per audit |
| Features (6 bento cells) | Auditor / Purification / Contracts / Zakat / Real-time / Secure | **AI Co-Auditor** (clause-by-clause), **AAOIFI Standard Mapping**, **Precise Citations** (page + section), **Purification Calculator**, **Firm + Client Workspaces**, **Audit Trail & Sign-off** |
| Pricing tiers | Free / Starter / Business / Enterprise (per-user) | **Solo Auditor** / **Boutique Firm** / **Enterprise Audit Firm** / **Custom (Sharia Boards)**, scaled by audited contracts/month and seat count |
| FAQ | Generic founder Qs | Firm Qs: data residency, AAOIFI version coverage, whether output replaces a Sharia board (no — it accelerates them), white-labeling, on-prem option, custom standards ingestion |
| Contact form | Name / Email / Message | Add a "Firm name" field — handled by the new key set; component change is minor (one extra input bound to a new translation key) |
| Metadata (title/description/og) | SMB pitch | "Hallha — AI Sharia auditor for AAOIFI-grade contract review" |

### Verification

1. `pnpm dev` (from `hallha-front-end`).
2. Visit `/` with `?locale=en` and `?locale=ar` (cookie-based). Verify direction flips, font swaps, no missing-key warnings in console.
3. Skim every section in both locales for: voice consistency, no leftover "founder/SMB" language, no dangling AAOIFI/Sharia jargon without context.
4. `pnpm build` to catch any TS type changes from JSON shape (none expected — keys preserved).

---

## Part 2 — Groq → Gemini migration (backend)

**Repo:** `E:\client-projects\hallha-node`

**Decision:** migrate audit LLM and guardrail to `gemini-2.0-flash` via `@langchain/google-genai`. Keep Whisper transcription on Groq — `GROQ_API_KEY` stays in env, retained only for `GROQ_TRANSCRIPTION_MODEL` use.

### Files to edit

- `package.json` — add `@langchain/google-genai`; **keep** `@langchain/groq` (still used for transcription).
- `src/config/env.ts` — add required `GOOGLE_API_KEY`, optional `GEMINI_MODEL` (default `gemini-2.0-flash`), optional `GEMINI_GUARDRAIL_MODEL` (default `gemini-2.0-flash`). Keep `GROQ_API_KEY` required (still needed for Whisper) and `GROQ_TRANSCRIPTION_MODEL`. Remove `GROQ_MODEL` and `GROQ_GUARDRAIL_MODEL`.
- `src/lib/llm.ts` — replace the two `ChatGroq` factory bodies with `ChatGoogleGenerativeAI`:
  - `getLlm()` → `new ChatGoogleGenerativeAI({ model: env.GEMINI_MODEL, apiKey: env.GOOGLE_API_KEY, temperature: 0.1 })`
  - `getGuardrailLlm()` → same with `GEMINI_GUARDRAIL_MODEL` and `temperature: 0`
  - `getLlmWithTools()` — unchanged at the call-site, just binds tools to the new Gemini instance.
- `.env.example` — add `GOOGLE_API_KEY=`, document the new vars; keep `GROQ_API_KEY` for transcription only.
- `README.md` — update the "Configuration" section if it lists model names.

### No-touch surfaces (confirmed provider-agnostic via LangChain)

- `src/agent/nodes.ts` — uses `getLlmWithTools()` only; no Groq-specific calls.
- `src/agent/synthesis.ts` — uses `getLlm()` only.
- `src/agent/guardrail.ts` — uses `getGuardrailLlm()` with `.withStructuredOutput(schema)` — Gemini supports this through `@langchain/google-genai`.
- `src/middleware/error.ts` — the rate-limit string matchers (`RESOURCE_EXHAUSTED`, `429`, `rate_limit_*`) are already broad enough to catch Gemini quota errors. Quick verification: add `quota` and `INVALID_ARGUMENT` matchers if surface tests reveal gaps.

### Verification

1. `pnpm typecheck` — catches missing exports from `@langchain/google-genai`.
2. `pnpm test` — existing Vitest suite mocks the LLM at the LangChain interface boundary, so it should still pass. Inspect `tests/*.test.ts` for any direct `ChatGroq` import (none expected).
3. Smoke test: `pnpm dev`, hit `POST /chat-audit` with a sample PDF and a `thread_id`. Confirm a structured audit response, no provider errors, and that the rate-limit code path still maps Gemini 429s to HTTP 429.
4. Guardrail check: send an off-topic message (e.g. "what's the weather?") and confirm the Arabic/English refusal still fires.

---

## Part 3 — RAG citation upgrade (backend)

**Repo:** `E:\client-projects\hallha-node`

The ingestion pipeline already writes `page`, `source`, `standard_number`, and `headings` per chunk. Three small reinforcements are needed:

### Files to edit

- `src/agent/nodes.ts` (`retrieveShariaRules` formatter, ~lines 114–213) — extend the per-source context line so the LLM sees page and section explicitly, not buried in metadata:
  - Current: `[id] (SCOPE) source_label\n{pageContent}`
  - New: `[id] (SCOPE) {source} — {standard_number || "—"} — p.{page || "?"} — § {headings || "—"}\n{pageContent}`
  - Also extend `sourcesHint` so each AVAILABLE SOURCES line carries `(p.N, § Heading)`.
- `src/agent/prompt.ts` (`buildHalimSystemPrompt`) — replace the "Identified Compliance Risks" sub-structure with a stricter four-field block:

  ```
  For EACH identified issue, use EXACTLY this structure (omit no field):
  - **Quoted clause** — verbatim from the user's uploaded document.
  - **Violation Description** — name the Sharia issue (Riba, Gharar, Maysir, prohibited industry, etc.), severity (High/Medium/Low), AND a 1–2 sentence plain-language explanation of why this clause is non-compliant.
  - **Standard Reference** — the AAOIFI standard NAME and NUMBER (e.g. "FAS 4 — Musharaka Financing"). Use the `standard_number` of the cited DOCUMENT source; if absent, write "Standard not identified in retrieved set" — never invent a number.
  - **Location** — page number and section heading from the cited source, formatted exactly: `p.{N}, § {section}`. Pull from the metadata visible in AVAILABLE SOURCES; if a field is missing, write "p.?" or "§ —".
  - **Solution / Purification (التطهير)** — a concrete, drafting-level sharia-compliant alternative. WHEN money has been earned or paid under the non-compliant clause, ALSO include a purification formula or method (e.g. "Calculate riba portion = principal × rate × days/360, then donate to non-zakat charity. No reward expected."). Otherwise, omit the purification line — do not fabricate filler.
  ```

  Keep the rest of the existing prompt (identity, language, web-search rules, citation markers, multi-tenant client-vs-AAOIFI pairing) intact — those are working well.

### No ingestion or schema changes

`src/rag/ingest.ts` and `src/utils/markdown-header-splitter.ts` already attach the required fields. Confirmed via the Explore pass: `metadata` includes `source`, `page`, `s3Key`, `s3Url`, `headings`, `standard_number`, plus the firm/client tags.

### Verification

1. Ingest a known AAOIFI PDF via `POST /upload-knowledge` and a known client contract via the client-document path.
2. `POST /chat-audit` against the client contract with a `thread_id`.
3. Confirm the response contains, for at least one violation, all four fields populated with page numbers and section headings drawn from the retrieved metadata (no `p.?` if the source PDF had page markers).
4. Negative check: ask a question where no source has a `standard_number` and confirm the model writes "Standard not identified in retrieved set" rather than hallucinating "FAS 99".
5. Purification check: feed a clause with realized riba and confirm a formula is included; feed a structural-only clause (e.g. uncertain delivery date) and confirm the purification line is omitted.

---

## Sequencing

1. **Part 2 (Gemini migration)** first — it's the most invasive runtime change. Land it, confirm `pnpm test` and a manual `/chat-audit` smoke test pass.
2. **Part 3 (RAG prompt + retriever formatter)** second — depends on Part 2 working so prompt iteration runs on the target model.
3. **Part 1 (landing copy)** last — purely frontend, can ship independently and in parallel if desired.
