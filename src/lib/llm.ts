import type { StructuredToolInterface } from '@langchain/core/tools';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { agentTools } from '../agent/tools.js';
import { env } from '../config/env.js';

let singleton: ChatGoogleGenerativeAI | null = null;
let guardrailSingleton: ChatGoogleGenerativeAI | null = null;
let llmWithTools: ReturnType<ChatGoogleGenerativeAI['bindTools']> | null = null;

export function getLlm(): ChatGoogleGenerativeAI {
  if (!singleton) {
    singleton = new ChatGoogleGenerativeAI({
      apiKey: env.GOOGLE_API_KEY,
      model: env.GEMINI_MODEL,
      temperature: 0,
    });
  }
  return singleton;
}

/** Lightweight Gemini for pre-RAG topic guardrail (no tools). */
export function getGuardrailLlm(): ChatGoogleGenerativeAI {
  if (!guardrailSingleton) {
    guardrailSingleton = new ChatGoogleGenerativeAI({
      apiKey: env.GOOGLE_API_KEY,
      model: env.GEMINI_GUARDRAIL_MODEL,
      temperature: 0,
    });
  }
  return guardrailSingleton;
}

/** Gemini + Tavily tool binding for the audit node only. */
export function getLlmWithTools(): ReturnType<ChatGoogleGenerativeAI['bindTools']> {
  if (!llmWithTools) {
    llmWithTools = getLlm().bindTools(agentTools as unknown as StructuredToolInterface[]);
  }
  return llmWithTools;
}
