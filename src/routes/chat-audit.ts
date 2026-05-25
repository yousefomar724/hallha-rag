import { Router, type Request, type Response } from 'express';
import { ObjectId } from 'mongodb';
import { HumanMessage } from '@langchain/core/messages';
import { memoryUpload, voiceUpload } from '../middleware/upload.js';
import { requireAuth } from '../middleware/require-auth.js';
import { usageLimitAudit } from '../middleware/usage-limit.js';
import {
  chatAuditMinuteLimiter,
  chatAuditHourlyLimiter,
  transcribeMinuteLimiter,
  transcribeHourlyLimiter,
} from '../middleware/rate-limit.js';
import { HttpError } from '../middleware/error.js';
import { extractPdfText } from '../utils/pdf.js';
import { getCompiledGraph, getEphemeralGraph } from '../agent/graph.js';
import type { RetrievedSource } from '../agent/prompt.js';
import { detectUserLanguage, type UserLanguage } from '../agent/greeting.js';
import { getPlan, UNLIMITED } from '../lib/plans.js';
import { namespaceThreadId, upsertThreadActivity } from '../lib/chat-history.js';
import { getClientForOrg } from '../lib/clients.js';
import { logger } from '../lib/logger.js';
import { transcribeAudioBuffer } from '../lib/groq-transcription.js';
import { DEFAULT_AUDIT_USER_MESSAGE } from '../agent/audit-defaults.js';
import { getDb } from '../lib/mongo.js';
import { parseUpstreamLlmError } from '../lib/llm-errors.js';

export const chatAuditRouter: Router = Router();

type AuditInputs = {
  userThreadId: string;
  namespacedThreadId: string;
  userInput: string;
  documentText: string;
  rawUserMessage: string | undefined;
  contextSummary: string;
  /** Validated audited-client id (must belong to req.activeOrgId). null = firm-wide chat. */
  clientId: string | null;
  /** When true, skip Mongo checkpointing and chat_thread writes (one-shot confidential run). */
  isConfidential: boolean;
  /** Detected script of the user's question (used to force response language). */
  userLanguage: UserLanguage;
};

async function loadOrgContextSummary(orgId: string): Promise<string> {
  const db = await getDb();
  const candidates: Record<string, unknown>[] = [{ id: orgId }];
  if (ObjectId.isValid(orgId)) candidates.push({ _id: new ObjectId(orgId) });
  const doc = await db.collection('organization').findOne({ $or: candidates });
  const s = doc?.contextSummary;
  return typeof s === 'string' ? s : '';
}

function asString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

function parseMultipartBool(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }
  return false;
}

function sourcesFromNodeOutput(output: unknown): RetrievedSource[] | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const src = (output as { sources?: unknown }).sources;
  if (!Array.isArray(src)) return undefined;
  return src as RetrievedSource[];
}

async function prepareAuditInputs(req: Request, res: Response): Promise<AuditInputs> {
  const threadId = typeof req.body?.thread_id === 'string' ? req.body.thread_id.trim() : '';
  if (!threadId) throw new HttpError(422, 'thread_id is required.');

  const rawClientId =
    typeof req.body?.client_id === 'string' && req.body.client_id.trim().length > 0
      ? req.body.client_id.trim()
      : null;
  let clientId: string | null = null;
  if (rawClientId) {
    const owned = await getClientForOrg(req.activeOrgId!, rawClientId);
    if (!owned) throw new HttpError(404, 'Client not found.');
    clientId = owned.id;
  }

  const contextSummary = await loadOrgContextSummary(req.activeOrgId!);

  const message: string | undefined =
    typeof req.body?.message === 'string' && req.body.message.length > 0
      ? req.body.message
      : undefined;

  const planKey = res.locals.planState?.plan ?? 'free';
  const maxDocPages = getPlan(planKey).limits.maxDocPages;

  let documentText = '';
  if (req.file) {
    const filename = req.file.originalname.toLowerCase();
    if (filename.endsWith('.pdf')) {
      const { text, pages } = await extractPdfText(new Uint8Array(req.file.buffer));
      documentText = text;
      const pageCount = pages.length;
      if (pageCount > maxDocPages) {
        const capLabel = maxDocPages === UNLIMITED ? 'unlimited' : String(maxDocPages);
        throw new HttpError(
          402,
          `Document has ${pageCount} pages; your plan allows up to ${capLabel} pages per document.`,
        );
      }
    } else {
      documentText = req.file.buffer.toString('utf-8');
    }
  }

  const userInput = message ?? DEFAULT_AUDIT_USER_MESSAGE;
  const isConfidential = parseMultipartBool(req.body?.isConfidential);
  // Prefer the user's raw question for language detection. The default audit
  // prompt is English and would otherwise override an Arabic upload-only turn.
  const userLanguage = detectUserLanguage(message ?? '');
  return {
    userThreadId: threadId,
    namespacedThreadId: namespaceThreadId(req.activeOrgId!, threadId, clientId),
    userInput,
    documentText,
    rawUserMessage: message,
    contextSummary,
    clientId,
    isConfidential,
    userLanguage,
  };
}

chatAuditRouter.post(
  '/chat-audit/transcribe',
  requireAuth,
  transcribeMinuteLimiter,
  transcribeHourlyLimiter,
  voiceUpload.single('audio'),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer?.length) {
        throw new HttpError(422, 'audio file is required.');
      }
      const rawName = req.file.originalname?.trim() || 'recording.webm';
      const text = (await transcribeAudioBuffer(req.file.buffer, rawName)).trim();
      if (!text.length) {
        throw new HttpError(422, 'No speech detected in the recording.');
      }
      res.json({ text });
    } catch (err) {
      next(err);
    }
  },
);

async function recordThreadActivity(req: Request, inputs: AuditInputs): Promise<void> {
  try {
    await upsertThreadActivity({
      threadId: inputs.namespacedThreadId,
      userThreadId: inputs.userThreadId,
      organizationId: req.activeOrgId!,
      userId: req.user!.id,
      clientId: inputs.clientId,
      firstMessageForTitle: inputs.rawUserMessage ?? null,
    });
  } catch (err) {
    logger.error({ err, threadId: inputs.namespacedThreadId }, 'Failed to upsert chat thread metadata');
  }
}

chatAuditRouter.post(
  '/chat-audit',
  requireAuth,
  chatAuditMinuteLimiter,
  chatAuditHourlyLimiter,
  usageLimitAudit(),
  memoryUpload.single('file'),
  async (req, res, next) => {
    try {
      const inputs = await prepareAuditInputs(req, res);

      const graph = inputs.isConfidential ? getEphemeralGraph() : await getCompiledGraph();
      const result = await graph.invoke(
        {
          messages: [new HumanMessage(inputs.userInput)],
          documentText: inputs.documentText,
          guardrailBlocked: false,
          contextSummary: inputs.contextSummary,
          clientId: inputs.clientId,
          userLanguage: inputs.userLanguage,
        },
        { configurable: { thread_id: inputs.namespacedThreadId } },
      );

      const lastMessage = result.messages.at(-1);
      const aiResponse = lastMessage ? asString(lastMessage.content) : '';
      const sources = Array.isArray(result.sources) ? result.sources : [];

      if (!inputs.isConfidential) {
        await recordThreadActivity(req, inputs);
      }

      res.json({
        response: aiResponse,
        thread_id: inputs.userThreadId,
        client_id: inputs.clientId,
        sources,
        citations: sources,
        ...(inputs.isConfidential ? { confidential: true } : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

function writeSse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

chatAuditRouter.post(
  '/chat-audit/stream',
  requireAuth,
  chatAuditMinuteLimiter,
  chatAuditHourlyLimiter,
  usageLimitAudit(),
  memoryUpload.single('file'),
  async (req, res, next) => {
    let inputs: AuditInputs;
    try {
      inputs = await prepareAuditInputs(req, res);
    } catch (err) {
      next(err);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 15_000);

    let aborted = false;
    req.on('close', () => {
      aborted = true;
      clearInterval(heartbeat);
    });

    try {
      const graph = inputs.isConfidential ? getEphemeralGraph() : await getCompiledGraph();
      writeSse(res, 'meta', {
        thread_id: inputs.userThreadId,
        client_id: inputs.clientId,
        ...(inputs.isConfidential ? { confidential: true } : {}),
      });

      // Persist the thread up-front so a mid-stream abort (Stop button) doesn't leave
      // a phantom thread that 404s on follow-up GET /chats/:id. Idempotent upsert.
      if (!inputs.isConfidential) {
        await recordThreadActivity(req, inputs);
      }

      const stream = graph.streamEvents(
        {
          messages: [new HumanMessage(inputs.userInput)],
          documentText: inputs.documentText,
          guardrailBlocked: false,
          contextSummary: inputs.contextSummary,
          clientId: inputs.clientId,
          userLanguage: inputs.userLanguage,
        },
        {
          configurable: { thread_id: inputs.namespacedThreadId },
          version: 'v2',
        },
      );

      let lastSourcesFromEvents: RetrievedSource[] = [];

      // Only the user-facing nodes should stream tokens to the client. Intermediate
      // LLM calls inside the CRAG loop (relevance evaluator, query rewriter, clause
      // parser, structured Sharia reasoning, guardrail classifier, purification
      // param extraction) all emit `on_chat_model_stream` events too — and their
      // structured-output JSON (e.g. `{"relevant":true,...}`) would otherwise leak
      // into the visible response. LangGraph v2 events carry `metadata.langgraph_node`
      // so we can filter to just the synthesis / chat-Q&A nodes.
      const STREAMABLE_NODES = new Set(['chatQa', 'synthesizeReport']);

      for await (const evt of stream) {
        if (aborted) break;
        if (evt && typeof evt === 'object' && 'event' in evt) {
          const eventName = (evt as { event: string }).event;
          if (eventName === 'on_chain_end') {
            const data = (evt as { data?: { output?: unknown } }).data;
            const next = sourcesFromNodeOutput(data?.output);
            if (next) lastSourcesFromEvents = next;
          }
          if (eventName === 'on_chat_model_stream') {
            const meta = (evt as { metadata?: { langgraph_node?: unknown } }).metadata;
            const node =
              typeof meta?.langgraph_node === 'string' ? meta.langgraph_node : '';
            if (!STREAMABLE_NODES.has(node)) continue;
            const chunk = (evt as { data?: { chunk?: { content?: unknown } } }).data?.chunk;
            const text = asString(chunk?.content);
            if (text.length > 0) writeSse(res, 'token', { text });
          }
        }
      }

      if (!aborted) {
        let sources: RetrievedSource[] = [];
        if (inputs.isConfidential) {
          sources = lastSourcesFromEvents;
        } else {
          try {
            const finalState = await graph.getState({
              configurable: { thread_id: inputs.namespacedThreadId },
            });
            sources = Array.isArray(finalState?.values?.sources)
              ? finalState.values.sources
              : [];
          } catch (stateErr) {
            logger.warn(
              { err: stateErr, threadId: inputs.namespacedThreadId },
              'Failed to read final graph state for sources',
            );
          }
        }
        writeSse(res, 'sources', { sources });
        writeSse(res, 'citations', { citations: sources });
        if (!inputs.isConfidential) {
          await recordThreadActivity(req, inputs);
        }
        writeSse(res, 'done', {
          thread_id: inputs.userThreadId,
          client_id: inputs.clientId,
          ...(inputs.isConfidential ? { confidential: true } : {}),
        });
      }
    } catch (err) {
      logger.error({ err, threadId: inputs.namespacedThreadId }, 'Stream error in /chat-audit/stream');
      const parsed = parseUpstreamLlmError(err);
      writeSse(res, 'error', {
        detail: parsed.message,
        kind: parsed.kind,
        status: parsed.status,
        ...(parsed.provider ? { provider: parsed.provider } : {}),
        ...(parsed.retryAfterSeconds ? { retryAfterSeconds: parsed.retryAfterSeconds } : {}),
      });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  },
);
