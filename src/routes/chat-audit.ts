import { Router, type Request, type Response } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import { memoryUpload } from '../middleware/upload.js';
import { requireAuth } from '../middleware/require-auth.js';
import { usageLimitAudit } from '../middleware/usage-limit.js';
import {
  chatAuditMinuteLimiter,
  chatAuditHourlyLimiter,
} from '../middleware/rate-limit.js';
import { HttpError } from '../middleware/error.js';
import { extractPdfText } from '../utils/pdf.js';
import { getCompiledGraph } from '../agent/graph.js';
import { getPlan, UNLIMITED } from '../lib/plans.js';
import { namespaceThreadId, upsertThreadActivity } from '../lib/chat-history.js';
import { logger } from '../lib/logger.js';

export const chatAuditRouter: Router = Router();

type AuditInputs = {
  userThreadId: string;
  namespacedThreadId: string;
  userInput: string;
  documentText: string;
  rawUserMessage: string | undefined;
};

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

async function prepareAuditInputs(req: Request, res: Response): Promise<AuditInputs> {
  const threadId = typeof req.body?.thread_id === 'string' ? req.body.thread_id.trim() : '';
  if (!threadId) throw new HttpError(422, 'thread_id is required.');

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

  const userInput = message ?? 'Please audit the attached document.';
  return {
    userThreadId: threadId,
    namespacedThreadId: namespaceThreadId(req.activeOrgId!, threadId),
    userInput,
    documentText,
    rawUserMessage: message,
  };
}

async function recordThreadActivity(req: Request, inputs: AuditInputs): Promise<void> {
  try {
    await upsertThreadActivity({
      threadId: inputs.namespacedThreadId,
      userThreadId: inputs.userThreadId,
      organizationId: req.activeOrgId!,
      userId: req.user!.id,
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

      const graph = await getCompiledGraph();
      const result = await graph.invoke(
        {
          messages: [new HumanMessage(inputs.userInput)],
          documentText: inputs.documentText,
        },
        { configurable: { thread_id: inputs.namespacedThreadId } },
      );

      const lastMessage = result.messages.at(-1);
      const aiResponse = lastMessage ? asString(lastMessage.content) : '';
      const sources = Array.isArray(result.sources) ? result.sources : [];

      await recordThreadActivity(req, inputs);

      res.json({
        response: aiResponse,
        thread_id: inputs.userThreadId,
        sources,
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
      const graph = await getCompiledGraph();
      writeSse(res, 'meta', { thread_id: inputs.userThreadId });

      const stream = graph.streamEvents(
        {
          messages: [new HumanMessage(inputs.userInput)],
          documentText: inputs.documentText,
        },
        {
          configurable: { thread_id: inputs.namespacedThreadId },
          version: 'v2',
        },
      );

      for await (const evt of stream) {
        if (aborted) break;
        if (evt.event === 'on_chat_model_stream') {
          const meta = (evt as { metadata?: Record<string, unknown> }).metadata;
          const node = meta?.langgraph_node;
          if (typeof node === 'string' && node !== 'audit') {
            continue;
          }
          const chunk = (evt.data as { chunk?: { content?: unknown } } | undefined)?.chunk;
          const text = asString(chunk?.content);
          if (text.length > 0) writeSse(res, 'token', { text });
        }
      }

      if (!aborted) {
        try {
          const finalState = await graph.getState({
            configurable: { thread_id: inputs.namespacedThreadId },
          });
          const sources = Array.isArray(finalState?.values?.sources)
            ? finalState.values.sources
            : [];
          writeSse(res, 'sources', { sources });
        } catch (stateErr) {
          logger.warn(
            { err: stateErr, threadId: inputs.namespacedThreadId },
            'Failed to read final graph state for sources',
          );
        }
        await recordThreadActivity(req, inputs);
        writeSse(res, 'done', { thread_id: inputs.userThreadId });
      }
    } catch (err) {
      logger.error({ err, threadId: inputs.namespacedThreadId }, 'Stream error in /chat-audit/stream');
      const message = err instanceof Error ? err.message : String(err);
      writeSse(res, 'error', { detail: message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  },
);
