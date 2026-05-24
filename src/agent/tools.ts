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

/**
 * Purification (التطهير) calculator. Invoked by the reasoning node when a riba/penalty
 * clause has detectable monetary fields. Pure arithmetic — no I/O.
 *
 *  simple_360: amount = principal × (annualRatePct / 100) × (days / 360)
 *  simple_365: amount = principal × (annualRatePct / 100) × (days / 365)
 */
export const PURIFICATION_TOOL_NAME = 'purification_calculator';

export const purificationCalculatorTool = new DynamicStructuredTool({
  name: PURIFICATION_TOOL_NAME,
  description:
    'Compute the Sharia purification (التطهير) amount for a non-compliant interest or late-payment clause. Use ONLY when the clause has concrete monetary parameters: principal, annual rate (percent), and elapsed days. Returns JSON { amount, formula, method }.',
  schema: z.object({
    principal: z.number().describe('Principal amount in the clause currency (any unit).'),
    annualRatePct: z
      .number()
      .describe('Annual interest / penalty rate as a percentage (e.g. 12 for 12%).'),
    days: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of days the rate has accrued.'),
    method: z
      .enum(['simple_360', 'simple_365'])
      .default('simple_360')
      .describe('Day-count convention. Default 360.'),
  }),
  func: async ({ principal, annualRatePct, days, method }) => {
    const dayBase = method === 'simple_365' ? 365 : 360;
    const amount = principal * (annualRatePct / 100) * (days / dayBase);
    const rounded = Math.round(amount * 100) / 100;
    return JSON.stringify({
      amount: rounded,
      formula: `${principal} × (${annualRatePct}% / 100) × (${days} / ${dayBase}) = ${rounded}`,
      method,
    });
  },
});

export const chatTools = [webSearchTool] as const;

export const agentTools = [webSearchTool, purificationCalculatorTool] as const;
