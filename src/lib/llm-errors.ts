/**
 * Normalises upstream LLM errors (Gemini, Groq) into a compact shape the rest
 * of the app can render. The raw provider messages are verbose JSON blobs that
 * make terrible toast text — this strips them down to a single sentence plus
 * optional retry hint.
 */

export type UpstreamLlmErrorKind =
  | 'quota_exhausted'
  | 'rate_limited'
  | 'invalid_api_key'
  | 'model_not_found'
  | 'upstream_error'
  | 'unknown';

export type ParsedUpstreamError = {
  kind: UpstreamLlmErrorKind;
  /** Short, human-readable single sentence. Safe for a toast title/description. */
  message: string;
  /** Provider-suggested retry delay, in seconds, when known. */
  retryAfterSeconds?: number;
  /** HTTP status that should be surfaced to the client. */
  status: number;
  /** The provider we think raised this, when identifiable. */
  provider?: 'gemini' | 'groq' | 'deepseek' | 'openrouter';
};

function extractRetryAfterSeconds(msg: string): number | undefined {
  // Gemini: "Please retry in 59.898343312s"
  const geminiSeconds = /retry\s+in\s+([0-9]+(?:\.[0-9]+)?)s/i.exec(msg);
  if (geminiSeconds && geminiSeconds[1]) {
    const v = Number(geminiSeconds[1]);
    if (Number.isFinite(v) && v > 0) return Math.ceil(v);
  }
  // Generic "retry-after: 30" or "retryDelay":"30s"
  const retryHeader = /retry[-_ ]?after[:\s]+([0-9]+)/i.exec(msg);
  if (retryHeader && retryHeader[1]) {
    const v = Number(retryHeader[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const retryDelay = /"retryDelay"\s*:\s*"([0-9]+)s"/.exec(msg);
  if (retryDelay && retryDelay[1]) {
    const v = Number(retryDelay[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

function detectProvider(
  name: string,
  msg: string,
): 'gemini' | 'groq' | 'deepseek' | 'openrouter' | undefined {
  if (
    name.includes('googlegenerativeai') ||
    msg.includes('GoogleGenerativeAI') ||
    msg.includes('generativelanguage.googleapis.com') ||
    msg.includes('ai.google.dev')
  ) {
    return 'gemini';
  }
  if (
    name.includes('groq') ||
    msg.includes('Groq API') ||
    msg.includes('api.groq.com') ||
    msg.includes('console.groq.com')
  ) {
    return 'groq';
  }
  if (
    msg.includes('openrouter.ai') ||
    msg.includes('openrouter') ||
    msg.includes('deepseek/deepseek-r1') ||
    msg.includes('deepseek/deepseek-chat') ||
    msg.includes('deepseek/deepseek-v3')
  ) {
    return 'openrouter';
  }
  if (
    msg.includes('api.deepseek.com') ||
    msg.includes('deepseek-reasoner') ||
    msg.includes('deepseek-chat') ||
    /\bdeepseek\b/i.test(msg)
  ) {
    return 'deepseek';
  }
  return undefined;
}

function providerLabel(p: ParsedUpstreamError['provider']): string {
  switch (p) {
    case 'gemini':
      return 'Gemini';
    case 'groq':
      return 'Groq';
    case 'deepseek':
      return 'DeepSeek';
    case 'openrouter':
      return 'OpenRouter';
    default:
      return 'the AI provider';
  }
}

export function parseUpstreamLlmError(err: unknown): ParsedUpstreamError {
  const isErr = err instanceof Error;
  const rawName = (isErr ? err.name : '').toLowerCase();
  const rawMsg = isErr ? err.message : String(err ?? '');
  const lowerMsg = rawMsg.toLowerCase();
  const provider = detectProvider(rawName, rawMsg);
  const retryAfterSeconds = extractRetryAfterSeconds(rawMsg);

  // Quota exhausted (paid limit, billing, daily/monthly caps, free-tier zero).
  const isQuotaExhausted =
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('resource_exhausted') ||
    lowerMsg.includes('exceeded your current quota') ||
    lowerMsg.includes('insufficient_quota') ||
    /limit:\s*0/.test(lowerMsg);

  // Per-minute / per-second rate limiting (transient, retry-friendly).
  const isRateLimited =
    !isQuotaExhausted &&
    (lowerMsg.includes('rate limit') ||
      lowerMsg.includes('rate_limit') ||
      lowerMsg.includes('too many requests') ||
      lowerMsg.includes('429'));

  if (isQuotaExhausted) {
    const where = `${providerLabel(provider)} API`;
    return {
      kind: 'quota_exhausted',
      message: `${where} quota exceeded. Check the project's billing or wait for the daily limit to reset.`,
      status: 429,
      provider,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  if (isRateLimited) {
    const where = providerLabel(provider);
    return {
      kind: 'rate_limited',
      message: retryAfterSeconds
        ? `${where} rate limit hit. Retry in about ${retryAfterSeconds}s.`
        : `${where} rate limit hit. Wait a moment and try again.`,
      status: 429,
      provider,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    };
  }

  if (
    lowerMsg.includes('api key not valid') ||
    lowerMsg.includes('invalid api key') ||
    lowerMsg.includes('api_key_invalid') ||
    lowerMsg.includes('permission_denied') ||
    lowerMsg.includes('unauthenticated')
  ) {
    return {
      kind: 'invalid_api_key',
      message: 'AI provider rejected the API key. Check the server configuration.',
      status: 502,
      provider,
    };
  }

  if (
    lowerMsg.includes('model not found') ||
    lowerMsg.includes('not_found') ||
    lowerMsg.includes('model is not supported')
  ) {
    return {
      kind: 'model_not_found',
      message: 'AI model not available on this account. Check the configured model name.',
      status: 502,
      provider,
    };
  }

  if (provider) {
    return {
      kind: 'upstream_error',
      message: `${providerLabel(provider)} returned an error. Try again shortly.`,
      status: 502,
      provider,
    };
  }

  return {
    kind: 'unknown',
    message: rawMsg.length > 200 ? rawMsg.slice(0, 197) + '…' : rawMsg || 'Unexpected error',
    status: 500,
  };
}
