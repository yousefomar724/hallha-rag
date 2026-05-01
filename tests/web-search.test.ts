import { describe, it, expect } from 'vitest';
import { AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import {
  harvestWebSourcesNode,
  mergeWebSourcesFromMessages,
  routeAfterAudit,
} from '../src/agent/nodes.js';
import type { AgentState } from '../src/agent/state.js';
import { WEB_SEARCH_TOOL_MESSAGE_NAME } from '../src/agent/tools.js';
import type { RetrievedSource } from '../src/agent/prompt.js';

function minimalState(partial: Partial<AgentState>): AgentState {
  return {
    messages: partial.messages ?? [],
    documentText: partial.documentText ?? '',
    context: partial.context ?? '',
    sources: partial.sources ?? [],
  };
}

describe('web search agent helpers', () => {
  it('routeAfterAudit routes to tools when last AI message has tool_calls', () => {
    const state = minimalState({
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'c1',
              name: WEB_SEARCH_TOOL_MESSAGE_NAME,
              args: { query: 'market news' },
              type: 'tool_call',
            },
          ],
        }),
      ],
    });
    expect(routeAfterAudit(state)).toBe('tools');
  });

  it('routeAfterAudit routes to harvest when no tool_calls', () => {
    const state = minimalState({
      messages: [new AIMessage('Answer without tools.')],
    });
    expect(routeAfterAudit(state)).toBe('harvestWebSources');
  });

  it('mergeWebSourcesFromMessages appends web rows after document ids', () => {
    const docs: RetrievedSource[] = [
      {
        id: 1,
        type: 'document',
        source: 'a.pdf',
        displayName: 'Doc A',
        page: 2,
      },
      {
        id: 2,
        type: 'document',
        source: 'b.pdf',
        displayName: 'Doc B',
        page: 3,
      },
    ];
    const json = JSON.stringify([
      {
        url: 'https://news.example/foo',
        title: 'Article',
        content: '',
        score: 0.9,
      },
    ]);
    const messages = [
      new ToolMessage({
        content: json,
        tool_call_id: 'call_1',
        name: WEB_SEARCH_TOOL_MESSAGE_NAME,
      }),
    ];
    const merged = mergeWebSourcesFromMessages(messages, docs);
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({
      id: 3,
      type: 'web',
      url: 'https://news.example/foo',
      displayName: 'Article',
    });
  });

  it('harvestWebSourcesNode merges tool JSON into sources', () => {
    const docs: RetrievedSource[] = [
      { id: 1, type: 'document', source: 'x.pdf', displayName: 'X', page: 1 },
    ];
    const json = JSON.stringify([
      { url: 'https://a.test', title: 'Web Title', content: '', score: 1 },
    ]);
    const state = minimalState({
      messages: [
        new ToolMessage({
          content: json,
          tool_call_id: 'c',
          name: WEB_SEARCH_TOOL_MESSAGE_NAME,
        }),
      ],
      sources: docs,
    });
    const up = harvestWebSourcesNode(state);
    expect(up.sources).toHaveLength(2);
    expect(up.sources![1]!.type).toBe('web');
    expect(up.sources![1]!.id).toBe(2);
  });

  it('mergeWebSourcesFromMessages ignores Tavily results from prior turns', () => {
    const docs: RetrievedSource[] = [
      { id: 1, type: 'document', source: 'x.pdf', displayName: 'X', page: 1 },
    ];
    const oldJson = JSON.stringify([
      { url: 'https://old.example', title: 'Stale', content: '', score: 1 },
    ]);
    const newJson = JSON.stringify([
      { url: 'https://new.example', title: 'Fresh', content: '', score: 1 },
    ]);
    const messages = [
      new HumanMessage('first question'),
      new ToolMessage({
        content: oldJson,
        tool_call_id: 'call_old',
        name: WEB_SEARCH_TOOL_MESSAGE_NAME,
      }),
      new AIMessage('prior answer'),
      new HumanMessage('second question'),
      new ToolMessage({
        content: newJson,
        tool_call_id: 'call_new',
        name: WEB_SEARCH_TOOL_MESSAGE_NAME,
      }),
    ];
    const merged = mergeWebSourcesFromMessages(messages, docs);
    const web = merged.filter((s) => s.type === 'web');
    expect(web).toHaveLength(1);
    expect(web[0]?.url).toBe('https://new.example');
  });
});
