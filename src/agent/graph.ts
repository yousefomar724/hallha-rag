import { END, START, StateGraph, type CompiledStateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AgentStateAnnotation } from './state.js';
import {
  greetingReplyNode,
  harvestWebSourcesNode,
  retrieveShariaRules,
  routeAfterAudit,
  routeOnEntry,
  shariaAuditNode,
} from './nodes.js';
import { agentTools } from './tools.js';
import { getCheckpointer } from '../lib/mongo.js';

export function buildWorkflow() {
  const toolsNode = new ToolNode([...agentTools]);

  return new StateGraph(AgentStateAnnotation)
    .addNode('greetingReply', greetingReplyNode)
    .addNode('retrieve', retrieveShariaRules)
    .addNode('audit', shariaAuditNode)
    .addNode('tools', toolsNode)
    .addNode('harvestWebSources', harvestWebSourcesNode)
    .addConditionalEdges(START, routeOnEntry, {
      greeting: 'greetingReply',
      audit: 'retrieve',
    })
    .addEdge('retrieve', 'audit')
    .addConditionalEdges('audit', routeAfterAudit, {
      tools: 'tools',
      harvestWebSources: 'harvestWebSources',
    })
    .addEdge('tools', 'audit')
    .addEdge('harvestWebSources', END)
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
