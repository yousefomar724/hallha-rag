import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { getRetriever } from '../lib/pinecone.js';
import { getLlmWithTools } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import {
  buildHalimSystemPrompt,
  formatSourceCitationLabel,
  type RetrievedSource,
} from './prompt.js';
import { detectGreeting, greetingReplyFor } from './greeting.js';
import type { AgentState, AgentStateUpdate } from './state.js';
import { getDisplayNamesForS3Keys } from '../lib/knowledge-files.js';
import { WEB_SEARCH_TOOL_MESSAGE_NAME } from './tools.js';

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

function basenameOnly(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'unknown';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
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

export function routeOnEntry(state: AgentState): 'greeting' | 'audit' {
  if (state.documentText && state.documentText.trim().length > 0) return 'audit';
  const text = lastUserText(state);
  return detectGreeting(text) ? 'greeting' : 'audit';
}

export function routeAfterAudit(state: AgentState): 'tools' | 'harvestWebSources' {
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

export async function retrieveShariaRules(state: AgentState): Promise<AgentStateUpdate> {
  const retriever = await getRetriever(4);
  const lastText = lastUserText(state);
  const searchQuery = lastText || state.documentText.slice(0, 500);

  if (!searchQuery.trim()) {
    return { context: '', sources: [] };
  }

  const docs = await retriever.invoke(searchQuery);

  const keysForLookup = docs
    .map((d) => {
      const meta = (d.metadata ?? {}) as { s3Key?: unknown };
      return typeof meta.s3Key === 'string' && meta.s3Key.length > 0 ? meta.s3Key : '';
    })
    .filter((k): k is string => k.length > 0);

  const displayNameByKey = await getDisplayNamesForS3Keys(keysForLookup);

  const sources: RetrievedSource[] = docs.map((d, i) => {
    const meta = (d.metadata ?? {}) as {
      source?: unknown;
      page?: unknown;
      s3Url?: unknown;
      headings?: unknown;
      s3Key?: unknown;
    };
    const rawSource =
      typeof meta.source === 'string' && meta.source ? meta.source : 'unknown';
    const source = basenameOnly(rawSource);
    const pageNum = Number(meta.page);
    const page = Number.isFinite(pageNum) ? pageNum : 0;
    const url = typeof meta.s3Url === 'string' && meta.s3Url ? meta.s3Url : undefined;
    const headings =
      typeof meta.headings === 'string' && meta.headings ? meta.headings : undefined;
    const s3Key =
      typeof meta.s3Key === 'string' && meta.s3Key.length > 0 ? meta.s3Key : undefined;
    const displayName =
      (s3Key && displayNameByKey.get(s3Key)) ||
      source;

    return {
      id: i + 1,
      type: 'document' as const,
      source,
      displayName,
      page,
      ...(url ? { url } : {}),
      ...(headings ? { headings } : {}),
    };
  });

  const context = docs
    .map((d, i) => {
      const s = sources[i]!;
      return `[${s.id}] ${formatSourceCitationLabel(s)}\n${d.pageContent}`;
    })
    .join('\n\n');

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

/** Exported for unit tests — merges Tavily ToolMessages into citation rows after audit completes. */
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

export async function shariaAuditNode(state: AgentState): Promise<AgentStateUpdate> {
  const systemPrompt = buildHalimSystemPrompt({
    context: state.context,
    documentText: state.documentText,
    sources: state.sources,
  });

  const llm = getLlmWithTools();
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
