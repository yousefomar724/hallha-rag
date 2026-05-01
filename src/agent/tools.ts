import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { env } from '../config/env.js';

/**
 * Tavily search for Halim — calls the public REST API (Community package does not export `TavilySearchResults` on our toolchain).
 * Matches ToolMessage.name after ToolNode executes.
 */
export const WEB_SEARCH_TOOL_MESSAGE_NAME = 'tavily_search_results_json';

export const webSearchTool = new DynamicStructuredTool({
  name: WEB_SEARCH_TOOL_MESSAGE_NAME,
  description:
    'Search the public web for recent or external information. Pass a concise search query string. Returns JSON array of { url, title, content, score }.',
  schema: z.object({
    query: z.string().describe('Concise web search query'),
  }),
  func: async ({ query }) => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        max_results: 4,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Tavily HTTP ${res.status}: ${text.slice(0, 280)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error('Tavily returned non-JSON response');
    }
    const raw =
      parsed &&
      typeof parsed === 'object' &&
      'results' in parsed &&
      Array.isArray((parsed as { results: unknown }).results)
        ? (parsed as { results: unknown[] }).results
        : [];
    const rows = raw.map((r) => {
      const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      return {
        url: typeof o.url === 'string' ? o.url : '',
        title: typeof o.title === 'string' ? o.title : '',
        content: typeof o.content === 'string' ? o.content : '',
        score: typeof o.score === 'number' ? o.score : 0,
      };
    });
    return JSON.stringify(rows);
  },
});

export const agentTools = [webSearchTool] as const;
