import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { getChatLlmWithTools } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { buildHalimSystemPrompt, type RetrievedSource } from './prompt.js';
import { guardrailRefusalMessageForUserText } from './audit-defaults.js';
import { detectGreeting, greetingReplyFor } from './greeting.js';
import { classifyRelatedToAudit, shouldSkipGuardrailLlm } from './guardrail.js';
import type { AgentState, AgentStateUpdate } from './state.js';
import { hybridRetrieve } from './retrieval.js';
import { formatSourcesFromCandidates } from './source-format.js';
import { WEB_SEARCH_TOOL_MESSAGE_NAME } from './tools.js';

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('429') ||
    msg.toLowerCase().includes('insufficient_quota') ||
    msg.toLowerCase().includes('rate_limit')
  );
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

function hostnameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

export function lastUserText(state: AgentState): string {
  const lastMessage = state.messages.at(-1);
  return lastMessage ? messageContentToText(lastMessage.content) : '';
}

/**
 * Three entry branches:
 *   - 'greeting' — bare greeting with no document
 *   - 'audit'    — a document was uploaded → run the new agentic CRAG pipeline
 *   - 'chat'     — no document, substantive question → run the simpler chat-Q&A path
 */
export function routeOnEntry(state: AgentState): 'greeting' | 'audit' | 'chat' {
  if (state.documentText && state.documentText.trim().length > 0) return 'audit';
  const text = lastUserText(state);
  return detectGreeting(text) ? 'greeting' : 'chat';
}

export function routeAfterChat(state: AgentState): 'tools' | 'harvestWebSources' {
  const last = state.messages.at(-1);
  if (
    last &&
    AIMessage.isInstance(last) &&
    Array.isArray(last.tool_calls) &&
    last.tool_calls.length > 0
  ) {
    return 'tools';
  }
  return 'harvestWebSources';
}

export function greetingReplyNode(state: AgentState): AgentStateUpdate {
  const text = lastUserText(state);
  const lang = detectGreeting(text) ?? 'en';
  const reply = greetingReplyFor(lang);
  return {
    messages: [new AIMessage(reply)],
    sources: [],
    context: '',
  };
}

export async function guardrailNode(state: AgentState): Promise<AgentStateUpdate> {
  const text = lastUserText(state);
  if (shouldSkipGuardrailLlm(state.documentText, text)) {
    return { guardrailBlocked: false };
  }

  const related = await classifyRelatedToAudit(text);
  if (related) {
    return { guardrailBlocked: false };
  }

  return {
    guardrailBlocked: true,
    messages: [new AIMessage(guardrailRefusalMessageForUserText(text))],
    context: '',
    sources: [],
  };
}

export function routeAfterGuardrail(state: AgentState): 'retrieve' | 'end' {
  return state.guardrailBlocked ? 'end' : 'retrieve';
}

/**
 * Chat-path retrieval (non-document). One Pinecone roundtrip + display-name lookup;
 * delegates formatting to the shared helper used by the CRAG loop.
 */
export async function retrieveShariaRules(state: AgentState): Promise<AgentStateUpdate> {
  const lastText = lastUserText(state);
  const searchQuery = lastText || state.documentText.slice(0, 500);

  if (!searchQuery.trim()) {
    return { context: '', sources: [] };
  }

  const { ordered } = await hybridRetrieve({
    query: searchQuery,
    clientId: state.clientId ?? null,
  });

  if (ordered.length === 0) {
    return { context: '', sources: [] };
  }

  const { sources, context } = await formatSourcesFromCandidates(ordered, 1);
  return { context, sources };
}

function parseWebRowsFromToolContent(content: unknown): {
  url: string;
  title: string;
  content: string;
  score: number;
}[] {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((p) =>
              p && typeof p === 'object' && 'text' in p
                ? String((p as { text?: unknown }).text ?? '')
                : '',
            )
            .join('')
        : '';
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      url: typeof o.url === 'string' ? o.url : '',
      title: typeof o.title === 'string' ? o.title : '',
      content: typeof o.content === 'string' ? o.content : '',
      score: typeof o.score === 'number' ? o.score : 0,
    };
  });
}

function messagesAfterLatestHuman(messages: AgentState['messages']): AgentState['messages'] {
  let lastIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (HumanMessage.isInstance(messages[i]!)) lastIdx = i;
  }
  if (lastIdx < 0) return messages;
  return messages.slice(lastIdx + 1);
}

export function mergeWebSourcesFromMessages(
  messages: AgentState['messages'],
  docSources: RetrievedSource[],
): RetrievedSource[] {
  const scoped = messagesAfterLatestHuman(messages);
  let maxId = docSources.reduce((m, s) => Math.max(m, s.id), 0);
  const webSources: RetrievedSource[] = [];

  for (const msg of scoped) {
    if (!ToolMessage.isInstance(msg)) continue;
    if (msg.name !== WEB_SEARCH_TOOL_MESSAGE_NAME) continue;
    const rows = parseWebRowsFromToolContent(msg.content);
    for (const row of rows) {
      if (!row.url && !row.title) continue;
      maxId += 1;
      const label =
        row.title.trim().length > 0 ? row.title.trim() : hostnameFromUrl(row.url);
      webSources.push({
        id: maxId,
        type: 'web',
        source: label,
        displayName: label,
        page: 0,
        url: row.url || undefined,
      });
    }
  }

  return [...docSources, ...webSources];
}

export function harvestWebSourcesNode(state: AgentState): AgentStateUpdate {
  const docSources = state.sources.filter((s) => s.type !== 'web');
  const merged = mergeWebSourcesFromMessages(state.messages, docSources);
  return { sources: merged };
}

/**
 * Chat-Q&A node (no document attached). DeepSeek-V3 + Tavily web search tool.
 * Stream events from this node become the SSE `token` payload for the chat path.
 */
export async function chatQaNode(state: AgentState): Promise<AgentStateUpdate> {
  const systemPrompt = buildHalimSystemPrompt({
    context: state.context,
    documentText: state.documentText,
    sources: state.sources,
    contextSummary: state.contextSummary,
  });

  const llm = getChatLlmWithTools();
  const messagesToSend = [new SystemMessage(systemPrompt), ...state.messages];

  try {
    const response = await llm.invoke(messagesToSend);
    return { messages: [response] };
  } catch (err) {
    if (isQuotaError(err)) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Chat LLM quota or rate limit',
      );
    }
    throw err;
  }
}

// Back-compat re-export (legacy name; some imports may still use it).
export { chatQaNode as shariaAuditNode };
// Back-compat re-export of legacy router name; same behavior as routeAfterChat.
export { routeAfterChat as routeAfterAudit };
