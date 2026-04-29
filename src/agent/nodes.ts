import { SystemMessage } from '@langchain/core/messages';
import { getRetriever } from '../lib/pinecone.js';
import { getLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import type { AgentState, AgentStateUpdate } from './state.js';

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429');
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

export async function retrieveShariaRules(state: AgentState): Promise<AgentStateUpdate> {
  const retriever = await getRetriever(4);
  const lastMessage = state.messages.at(-1);
  const lastText = lastMessage ? messageContentToText(lastMessage.content) : '';
  const searchQuery = lastText || state.documentText.slice(0, 500);

  if (!searchQuery.trim()) {
    return { context: '' };
  }

  const docs = await retriever.invoke(searchQuery);
  const context = docs.map((d) => d.pageContent).join('\n\n');
  return { context };
}

export async function shariaAuditNode(state: AgentState): Promise<AgentStateUpdate> {
  const systemPrompt = `
    You are a Senior Sharia Auditor.

    REFERENCE STANDARDS (From Knowledge Base):
    ${state.context}

    USER'S UPLOADED DOCUMENT (If any):
    ${state.documentText ? state.documentText : 'No document uploaded.'}

    INSTRUCTIONS:
    - If a document is provided, perform a Sharia audit against the Reference Standards.
    - Look for Riba (interest) or Gharar (uncertainty).
    - If no document is provided, answer the user's question using the Reference Standards.
    - Always base your answers on the provided context.
    `;

  const llm = getLlm();
  const messagesToSend = [new SystemMessage(systemPrompt), ...state.messages];

  try {
    const response = await llm.invoke(messagesToSend);
    return { messages: [response] };
  } catch (err) {
    // Do not backoff-retry RESOURCE_EXHAUSTED: free-tier daily/minute caps rarely clear within
    // seconds; long waits only extend request time (~minutes) before the same 429.
    if (isQuotaError(err)) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'LLM quota or rate limit',
      );
    }
    throw err;
  }
}
