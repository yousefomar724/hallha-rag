import { describe, it, expect } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { routeOnEntry } from '../src/agent/nodes.js';
import type { AgentState } from '../src/agent/state.js';

function makeState(partial: {
  messages?: HumanMessage[];
  documentText?: string;
}): AgentState {
  return {
    messages: partial.messages ?? [],
    documentText: partial.documentText ?? '',
    context: '',
    sources: [],
  };
}

describe('routeOnEntry', () => {
  it('always routes to audit when a document is present', () => {
    expect(
      routeOnEntry(
        makeState({
          messages: [new HumanMessage('السلام عليكم')],
          documentText: 'some pdf text',
        }),
      ),
    ).toBe('audit');
  });

  it('routes pure English greetings to greeting', () => {
    expect(routeOnEntry(makeState({ messages: [new HumanMessage('hello')] }))).toBe('greeting');
    expect(routeOnEntry(makeState({ messages: [new HumanMessage('Hi!')] }))).toBe('greeting');
    expect(routeOnEntry(makeState({ messages: [new HumanMessage('good morning')] }))).toBe(
      'greeting',
    );
  });

  it('routes pure Arabic greetings to greeting', () => {
    expect(routeOnEntry(makeState({ messages: [new HumanMessage('السلام عليكم')] }))).toBe(
      'greeting',
    );
    expect(routeOnEntry(makeState({ messages: [new HumanMessage('مرحبا')] }))).toBe('greeting');
  });

  it('does not treat hello inside a substantive message as a greeting', () => {
    expect(
      routeOnEntry(
        makeState({
          messages: [new HumanMessage('hello, please review this sukuk structure for riba')],
        }),
      ),
    ).toBe('audit');
  });

  it('routes substantive questions to audit', () => {
    expect(
      routeOnEntry(
        makeState({
          messages: [new HumanMessage('Is murabaha permissible for this facility?')],
        }),
      ),
    ).toBe('audit');
  });
});
