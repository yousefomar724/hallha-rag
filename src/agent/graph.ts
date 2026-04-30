import { END, START, StateGraph, type CompiledStateGraph } from '@langchain/langgraph';
import { AgentStateAnnotation } from './state.js';
import {
  greetingReplyNode,
  retrieveShariaRules,
  routeOnEntry,
  shariaAuditNode,
} from './nodes.js';
import { getCheckpointer } from '../lib/mongo.js';

export function buildWorkflow() {
  return new StateGraph(AgentStateAnnotation)
    .addNode('greetingReply', greetingReplyNode)
    .addNode('retrieve', retrieveShariaRules)
    .addNode('audit', shariaAuditNode)
    .addConditionalEdges(START, routeOnEntry, {
      greeting: 'greetingReply',
      audit: 'retrieve',
    })
    .addEdge('retrieve', 'audit')
    .addEdge('audit', END)
    .addEdge('greetingReply', END);
}

let compiled: ReturnType<ReturnType<typeof buildWorkflow>['compile']> | null = null;

export async function getCompiledGraph() {
  if (!compiled) {
    const checkpointer = await getCheckpointer();
    compiled = buildWorkflow().compile({ checkpointer });
  }
  return compiled;
}

export type ShariaGraph = Awaited<ReturnType<typeof getCompiledGraph>>;
// Reference for type re-exports if needed downstream
export type _ShariaGraphTypeRef = CompiledStateGraph<unknown, unknown> | null;
