import type { StructuredToolInterface } from '@langchain/core/tools';
import { ChatGroq } from '@langchain/groq';
import { agentTools } from '../agent/tools.js';
import { env } from '../config/env.js';

let singleton: ChatGroq | null = null;
let guardrailSingleton: ChatGroq | null = null;
let llmWithTools: ReturnType<ChatGroq['bindTools']> | null = null;

export function getLlm(): ChatGroq {
  if (!singleton) {
    singleton = new ChatGroq({
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL,
      temperature: 0,
    });
  }
  return singleton;
}

/** Lightweight ChatGroq for pre-RAG topic guardrail (no tools). */
export function getGuardrailLlm(): ChatGroq {
  if (!guardrailSingleton) {
    guardrailSingleton = new ChatGroq({
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_GUARDRAIL_MODEL,
      temperature: 0,
    });
  }
  return guardrailSingleton;
}

/** ChatGroq + Tavily tool binding for the audit node only. */
export function getLlmWithTools(): ReturnType<ChatGroq['bindTools']> {
  if (!llmWithTools) {
    llmWithTools = getLlm().bindTools(agentTools as unknown as StructuredToolInterface[]);
  }
  return llmWithTools;
}
