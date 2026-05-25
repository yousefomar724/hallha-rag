import type { StructuredToolInterface } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { agentTools, chatTools } from '../agent/tools.js';
import { env } from '../config/env.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function openRouterConfiguration() {
  return {
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': env.OPENROUTER_HTTP_REFERER,
      'X-Title': env.OPENROUTER_APP_TITLE,
    },
  };
}

/**
 * Optional OpenRouter provider routing. Passed through `modelKwargs.provider`
 * so it lands in the request body as `provider: { order: [...], allow_fallbacks: true }`.
 * Returns undefined when the env is unset → OpenRouter picks the cheapest provider as today.
 */
function openRouterProviderRouting(): { provider: { order: string[]; allow_fallbacks: boolean } } | undefined {
  const raw = env.OPENROUTER_PROVIDER_ORDER?.trim();
  if (!raw) return undefined;
  const order = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (order.length === 0) return undefined;
  return { provider: { order, allow_fallbacks: true } };
}

let reasoningSingleton: ChatOpenAI | null = null;
let chatSingleton: ChatOpenAI | null = null;
let reasoningWithTools: ReturnType<ChatOpenAI['bindTools']> | null = null;
let chatWithTools: ReturnType<ChatOpenAI['bindTools']> | null = null;
let reasoningWithChatTools: ReturnType<ChatOpenAI['bindTools']> | null = null;

/** DeepSeek-R1 via OpenRouter (chain-of-thought). Use for compliance reasoning + final report synthesis. */
export function getReasoningLlm(): ChatOpenAI {
  if (!reasoningSingleton) {
    const providerRouting = openRouterProviderRouting();
    reasoningSingleton = new ChatOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_REASONING_MODEL,
      temperature: 0,
      maxTokens: env.OPENROUTER_REASONING_MAX_TOKENS,
      configuration: openRouterConfiguration(),
      ...(providerRouting ? { modelKwargs: providerRouting } : {}),
    });
  }
  return reasoningSingleton;
}

/** DeepSeek chat via OpenRouter (fast). Use for guardrail, clause parsing, CRAG evaluator, query rewriting, and chat-Q&A. */
export function getChatLlm(): ChatOpenAI {
  if (!chatSingleton) {
    const providerRouting = openRouterProviderRouting();
    chatSingleton = new ChatOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_CHAT_MODEL,
      temperature: 0,
      maxTokens: env.OPENROUTER_CHAT_MAX_TOKENS,
      configuration: openRouterConfiguration(),
      ...(providerRouting ? { modelKwargs: providerRouting } : {}),
    });
  }
  return chatSingleton;
}

/** Reasoning model + all agent tools (web search + purification calculator). */
export function getReasoningLlmWithTools(): ReturnType<ChatOpenAI['bindTools']> {
  if (!reasoningWithTools) {
    reasoningWithTools = getReasoningLlm().bindTools(
      agentTools as unknown as StructuredToolInterface[],
    );
  }
  return reasoningWithTools;
}

/** Chat model + agent tools (used by the non-document chat-Q&A node for Tavily web search). */
export function getChatLlmWithTools(): ReturnType<ChatOpenAI['bindTools']> {
  if (!chatWithTools) {
    chatWithTools = getChatLlm().bindTools(chatTools as unknown as StructuredToolInterface[]);
  }
  return chatWithTools;
}

/** Reasoning model + chat tools only (Tavily). For chat-Q&A when files are in play. */
export function getReasoningLlmWithChatTools(): ReturnType<ChatOpenAI['bindTools']> {
  if (!reasoningWithChatTools) {
    reasoningWithChatTools = getReasoningLlm().bindTools(
      chatTools as unknown as StructuredToolInterface[],
    );
  }
  return reasoningWithChatTools;
}

// ---- Back-compat aliases (legacy call sites) ----
// Existing consumers (synthesis.ts, guardrail.ts) reference getLlm / getGuardrailLlm /
// getLlmWithTools. Keep these working by aliasing to the OpenRouter factories.

/** @deprecated Use getReasoningLlm(). */
export const getLlm = getReasoningLlm;
/** @deprecated Use getChatLlm(). */
export const getGuardrailLlm = getChatLlm;
/** @deprecated Use getChatLlmWithTools() for chat path or getReasoningLlmWithTools() for audit. */
export const getLlmWithTools = getChatLlmWithTools;
