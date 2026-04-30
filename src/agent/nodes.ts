import { SystemMessage } from '@langchain/core/messages';
import { getRetriever } from '../lib/pinecone.js';
import { getLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { buildHalimSystemPrompt, type RetrievedSource } from './prompt.js';
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
    return { context: '', sources: [] };
  }

  const docs = await retriever.invoke(searchQuery);

  const sources: RetrievedSource[] = docs.map((d, i) => {
    const meta = (d.metadata ?? {}) as { source?: unknown; page?: unknown };
    const source = typeof meta.source === 'string' && meta.source ? meta.source : 'unknown';
    const pageNum = Number(meta.page);
    const page = Number.isFinite(pageNum) ? pageNum : 0;
    return { id: i + 1, source, page };
  });

  const context = docs
    .map((d, i) => {
      const s = sources[i]!;
      return `[${s.id}] ${s.source}, p. ${s.page}\n${d.pageContent}`;
    })
    .join('\n\n');

  return { context, sources };
}

export async function shariaAuditNode(state: AgentState): Promise<AgentStateUpdate> {
  const systemPrompt = buildHalimSystemPrompt({
    context: state.context,
    documentText: state.documentText,
    sources: state.sources,
  });

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
