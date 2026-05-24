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

let reasoningSingleton: ChatOpenAI | null = null;
let chatSingleton: ChatOpenAI | null = null;
let reasoningWithTools: ReturnType<ChatOpenAI['bindTools']> | null = null;
let chatWithTools: ReturnType<ChatOpenAI['bindTools']> | null = null;

/** DeepSeek-R1 via OpenRouter (chain-of-thought). Use for compliance reasoning + final report synthesis. */
export function getReasoningLlm(): ChatOpenAI {
  if (!reasoningSingleton) {
    reasoningSingleton = new ChatOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_REASONING_MODEL,
      temperature: 0,
      configuration: openRouterConfiguration(),
    });
  }
  return reasoningSingleton;
}

/** DeepSeek chat via OpenRouter (fast). Use for guardrail, clause parsing, CRAG evaluator, query rewriting, and chat-Q&A. */
export function getChatLlm(): ChatOpenAI {
  if (!chatSingleton) {
    chatSingleton = new ChatOpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_CHAT_MODEL,
      temperature: 0,
      configuration: openRouterConfiguration(),
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

// ---- Back-compat aliases (legacy call sites) ----
// Existing consumers (synthesis.ts, guardrail.ts) reference getLlm / getGuardrailLlm /
// getLlmWithTools. Keep these working by aliasing to the OpenRouter factories.

/** @deprecated Use getReasoningLlm(). */
export const getLlm = getReasoningLlm;
/** @deprecated Use getChatLlm(). */
export const getGuardrailLlm = getChatLlm;
/** @deprecated Use getChatLlmWithTools() for chat path or getReasoningLlmWithTools() for audit. */
export const getLlmWithTools = getChatLlmWithTools;
