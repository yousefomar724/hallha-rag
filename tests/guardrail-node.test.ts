import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';

import {
  DEFAULT_AUDIT_USER_MESSAGE,
  GUARDRAIL_REFUSAL_MESSAGE_AR,
  GUARDRAIL_REFUSAL_MESSAGE_EN,
} from '../src/agent/audit-defaults.js';
import type { AgentState } from '../src/agent/state.js';

const classifyMock = vi.hoisted(() => vi.fn());
const skipMock = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/guardrail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agent/guardrail.js')>();
  return {
    ...actual,
    classifyRelatedToAudit: classifyMock,
    shouldSkipGuardrailLlm: skipMock,
  };
});

const { guardrailNode } = await import('../src/agent/nodes.js');

function baseState(overrides: Partial<AgentState>): AgentState {
  return {
    messages: [],
    documentText: '',
    context: '',
    sources: [],
    guardrailBlocked: false,
    ...overrides,
  };
}

describe('guardrailNode', () => {
  beforeEach(() => {
    classifyMock.mockReset();
    skipMock.mockReset();
  });

  it('allows when shouldSkipGuardrailLlm is true', async () => {
    skipMock.mockReturnValue(true);
    const state = baseState({
      messages: [new HumanMessage(DEFAULT_AUDIT_USER_MESSAGE)],
      documentText: 'contract text',
    });
    const update = await guardrailNode(state);
    expect(update).toEqual({ guardrailBlocked: false });
    expect(classifyMock).not.toHaveBeenCalled();
  });

  it('blocks and returns branded refusal when classifier returns false', async () => {
    skipMock.mockReturnValue(false);
    classifyMock.mockResolvedValue(false);
    const state = baseState({
      messages: [new HumanMessage('tell me a joke')],
      documentText: '',
    });
    const update = await guardrailNode(state);
    expect(update.guardrailBlocked).toBe(true);
    expect(update.context).toBe('');
    expect(update.sources).toEqual([]);
    const msg = update.messages?.[0];
    expect(msg?.content).toBe(GUARDRAIL_REFUSAL_MESSAGE_EN);
  });

  it('blocks with Arabic refusal when the user wrote in Arabic', async () => {
    skipMock.mockReturnValue(false);
    classifyMock.mockResolvedValue(false);
    const state = baseState({
      messages: [new HumanMessage('كيف أطبخ المعكرونة؟')],
      documentText: '',
    });
    const update = await guardrailNode(state);
    expect(update.guardrailBlocked).toBe(true);
    const msg = update.messages?.[0];
    expect(msg?.content).toBe(GUARDRAIL_REFUSAL_MESSAGE_AR);
  });

  it('allows when classifier returns true', async () => {
    skipMock.mockReturnValue(false);
    classifyMock.mockResolvedValue(true);
    const state = baseState({
      messages: [new HumanMessage('check this sukuk for sharia compliance')],
      documentText: '',
    });
    const update = await guardrailNode(state);
    expect(update).toEqual({ guardrailBlocked: false });
  });
});
