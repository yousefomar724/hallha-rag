import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { RetrievedSource } from './prompt.js';

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  documentText: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  context: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  sources: Annotation<RetrievedSource[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** Set when guardrail refuses; reset to false on each HTTP invoke from chat-audit. */
  guardrailBlocked: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  /** Onboarding profile (org); injected from HTTP into every invoke. */
  contextSummary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** Audited-client id (firm's client). When set, retrieval queries both the global AAOIFI namespace and `client_tenant_:clientId`. */
  clientId: Annotation<string | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;
export type AgentStateUpdate = typeof AgentStateAnnotation.Update;
