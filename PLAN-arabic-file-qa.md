# Arabic-aware file Q&A + main reasoning model for file context

## Context

When a user uploads a file inline in `/chat-audit` and asks in Arabic, the response comes back in English. The user assumes a "fallback" model is responding. In reality:

- The inline-file scenario runs the **CRAG audit branch**, whose final node (`synthesizeReportNode` at [src/agent/audit-report.ts:105](src/agent/audit-report.ts)) already uses **Deepseek-R1** (the main reasoning model). The model is right; the **prompt is wrong** — it says "Default to English if mixed" without ever being told the user's question language.
- For follow-up turns about a previously-uploaded client document (no file attached, just `client_id`), the chat-Q&A path runs (`chatQaNode` at [src/agent/nodes.ts:224](src/agent/nodes.ts)) which uses **Deepseek-chat** (V3). The user wants Deepseek-R1 here too whenever files are in play.

Two fixes:
1. **Language detection** — detect user's message language (ar / en / mixed) at the route boundary, thread through state, inject explicit directive into the two user-facing prompts.
2. **Model swap for file context** — `chatQaNode` switches to the reasoning model whenever `documentText` or `clientId` is present.

## Changes

1. **`src/agent/greeting.ts`** — add `detectUserLanguage(text): 'ar' | 'en' | 'mixed'`.
2. **`src/agent/state.ts`** — add `userLanguage` channel to `AgentStateAnnotation` (replace reducer, default `'en'`).
3. **`src/routes/chat-audit.ts`** — detect language in `prepareAuditInputs`; seed `userLanguage` in initial state for both JSON and SSE handlers.
4. **`src/lib/llm.ts`** — add `getReasoningLlmWithChatTools()` singleton (R1 + Tavily only, no purification calculator).
5. **`src/agent/prompt.ts`** — `buildHalimSystemPrompt` accepts `userLanguage`; replace LANGUAGE block with explicit directive.
6. **`src/agent/audit-report.ts`** — `buildReportSystemPrompt` accepts `userLanguage`; replace "Default to English if mixed" line; `synthesizeReportNode` threads `state.userLanguage`.
7. **`src/agent/nodes.ts`** — `chatQaNode` picks `getReasoningLlmWithChatTools` when `documentText` OR `clientId` is set; threads `state.userLanguage`.

## Tests

- Unit: `detectUserLanguage` covering pure/mixed/empty inputs.
- Unit: prompt builders include Arabic directive when `userLanguage='ar'`.
- Integration (mocked LLM): Arabic + `documentText` → synthesis prompt contains Arabic directive; `clientId` set → reasoning factory selected.

## Verification

```bash
curl -X POST http://localhost:8000/chat-audit \
  -H 'Authorization: Bearer ...' -F 'thread_id=t1' \
  -F 'message=حلل هذا العقد من ناحية الامتثال الشرعي' \
  -F 'file=@contract.pdf'

curl -X POST http://localhost:8000/chat-audit \
  -H 'Authorization: Bearer ...' \
  -F 'thread_id=t2' -F 'client_id=<id>' \
  -F 'message=ما حكم بند الغرامة المذكور سابقاً؟'
```

Run `pnpm typecheck` and `pnpm test` after.

## Notes

- DeepSeek-R1 emits `<think>` tokens before answering — verify SSE stream doesn't leak chain-of-thought; if it does, strip in the SSE forwarder.
- `temperature: 0` on R1 sometimes ignored; the directive uses "MUST"/"Do NOT switch" to be explicit.
- Mixed-language defaults to Arabic (acceptable for Arabic-speaking auditor firms).
