import { describe, it, expect } from 'vitest';

import {
  DEFAULT_AUDIT_USER_MESSAGE,
  guardrailRefusalMessageForUserText,
  GUARDRAIL_REFUSAL_MESSAGE_AR,
  GUARDRAIL_REFUSAL_MESSAGE_EN,
} from '../src/agent/audit-defaults.js';
import { shouldSkipGuardrailLlm } from '../src/agent/guardrail.js';
import { routeAfterGuardrail } from '../src/agent/nodes.js';
import type { AgentState } from '../src/agent/state.js';

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

describe('shouldSkipGuardrailLlm', () => {
  it('is true when document is present and message is the default audit placeholder', () => {
    expect(shouldSkipGuardrailLlm('some doc', DEFAULT_AUDIT_USER_MESSAGE)).toBe(true);
  });

  it('is false when document is present but the user sent a custom message', () => {
    expect(shouldSkipGuardrailLlm('some doc', 'Tell me a joke')).toBe(false);
  });

  it('is false when there is no document text', () => {
    expect(shouldSkipGuardrailLlm('', DEFAULT_AUDIT_USER_MESSAGE)).toBe(false);
  });
});

describe('guardrailRefusalMessageForUserText', () => {
  it('returns English when the message has no Arabic script', () => {
    expect(guardrailRefusalMessageForUserText('tell me a joke')).toBe(GUARDRAIL_REFUSAL_MESSAGE_EN);
  });

  it('returns Arabic when the message includes Arabic script', () => {
    expect(guardrailRefusalMessageForUserText('ما هي عاصمة فرنسا؟')).toBe(GUARDRAIL_REFUSAL_MESSAGE_AR);
  });

  it('treats mixed inputs with Arabic as Arabic', () => {
    expect(guardrailRefusalMessageForUserText('hello طبخ')).toBe(GUARDRAIL_REFUSAL_MESSAGE_AR);
  });
});

describe('routeAfterGuardrail', () => {
  it('routes to end when blocked', () => {
    expect(routeAfterGuardrail(baseState({ guardrailBlocked: true }))).toBe('end');
  });

  it('routes to retrieve when not blocked', () => {
    expect(routeAfterGuardrail(baseState({ guardrailBlocked: false }))).toBe('retrieve');
  });
});
