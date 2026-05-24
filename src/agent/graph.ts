import { END, START, StateGraph, type CompiledStateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AgentStateAnnotation } from './state.js';
import {
  chatQaNode,
  greetingReplyNode,
  guardrailNode,
  harvestWebSourcesNode,
  retrieveShariaRules,
  routeAfterChat,
  routeAfterGuardrail,
  routeOnEntry,
} from './nodes.js';
import { parseClausesNode } from './hierarchical-parser.js';
import {
  retrieveForClauseNode,
  rewriteQueryNode,
  routeAfterRetrieve,
} from './crag-evaluator.js';
import {
  advanceClauseNode,
  reasoningNode,
  routeAfterAdvance,
  skipClauseNode,
} from './sharia-reasoning.js';
import { synthesizeReportNode } from './audit-report.js';
import { chatTools } from './tools.js';
import { getCheckpointer } from '../lib/mongo.js';

export function buildWorkflow() {
  // Chat-path tools (Tavily web search bound to chatQa).
  const webToolsNode = new ToolNode([...chatTools]);

  return (
    new StateGraph(AgentStateAnnotation)
      // shared
      .addNode('greetingReply', greetingReplyNode)
      .addNode('guardrail', guardrailNode)

      // chat-Q&A branch (no document)
      .addNode('retrieve', retrieveShariaRules)
      .addNode('chatQa', chatQaNode)
      .addNode('webTools', webToolsNode)
      .addNode('harvestWebSources', harvestWebSourcesNode)

      // agentic audit branch (document attached) — CRAG
      .addNode('parseClauses', parseClausesNode)
      .addNode('retrieveForClause', retrieveForClauseNode)
      .addNode('rewriteQuery', rewriteQueryNode)
      .addNode('reasoning', reasoningNode)
      .addNode('skipClause', skipClauseNode)
      .addNode('advanceClause', advanceClauseNode)
      .addNode('synthesizeReport', synthesizeReportNode)

      // ---- Edges ----
      .addConditionalEdges(START, routeOnEntry, {
        greeting: 'greetingReply',
        chat: 'guardrail',
        audit: 'parseClauses',
      })
      .addEdge('greetingReply', END)

      // chat branch
      .addConditionalEdges('guardrail', routeAfterGuardrail, {
        retrieve: 'retrieve',
        end: END,
      })
      .addEdge('retrieve', 'chatQa')
      .addConditionalEdges('chatQa', routeAfterChat, {
        tools: 'webTools',
        harvestWebSources: 'harvestWebSources',
      })
      .addEdge('webTools', 'chatQa')
      .addEdge('harvestWebSources', END)

      // audit branch (CRAG loop)
      .addEdge('parseClauses', 'retrieveForClause')
      .addConditionalEdges('retrieveForClause', routeAfterRetrieve, {
        reasoning: 'reasoning',
        rewrite: 'rewriteQuery',
        skip: 'skipClause',
      })
      .addEdge('rewriteQuery', 'retrieveForClause')
      .addEdge('reasoning', 'advanceClause')
      .addConditionalEdges('advanceClause', routeAfterAdvance, {
        next: 'retrieveForClause',
        synthesize: 'synthesizeReport',
      })
      .addConditionalEdges('skipClause', routeAfterAdvance, {
        next: 'retrieveForClause',
        synthesize: 'synthesizeReport',
      })
      .addEdge('synthesizeReport', END)
  );
}

let compiled: ReturnType<ReturnType<typeof buildWorkflow>['compile']> | null = null;
let compiledEphemeral: ReturnType<ReturnType<typeof buildWorkflow>['compile']> | null = null;

export async function getCompiledGraph() {
  if (!compiled) {
    const checkpointer = await getCheckpointer();
    compiled = buildWorkflow().compile({ checkpointer });
  }
  return compiled;
}

/** Same workflow without MongoDB checkpointing — for confidential one-shot audits (no retained thread state). */
export function getEphemeralGraph() {
  if (!compiledEphemeral) {
    compiledEphemeral = buildWorkflow().compile();
  }
  return compiledEphemeral;
}

export type ShariaGraph = Awaited<ReturnType<typeof getCompiledGraph>>;
// Reference for type re-exports if needed downstream
export type _ShariaGraphTypeRef = CompiledStateGraph<unknown, unknown> | null;
