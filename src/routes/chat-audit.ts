import { Router } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import { memoryUpload } from '../middleware/upload.js';
import { requireAuth } from '../middleware/require-auth.js';
import { usageLimitAudit } from '../middleware/usage-limit.js';
import { HttpError } from '../middleware/error.js';
import { extractPdfText } from '../utils/pdf.js';
import { getCompiledGraph } from '../agent/graph.js';
import { getPlan, UNLIMITED } from '../lib/plans.js';

export const chatAuditRouter: Router = Router();

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

chatAuditRouter.post(
  '/chat-audit',
  requireAuth,
  usageLimitAudit(),
  memoryUpload.single('file'),
  async (req, res, next) => {
    try {
      const threadId = typeof req.body?.thread_id === 'string' ? req.body.thread_id.trim() : '';
      if (!threadId) {
        throw new HttpError(422, 'thread_id is required.');
      }
      const namespacedThreadId = `${req.activeOrgId}:${threadId}`;

      const message: string | undefined =
        typeof req.body?.message === 'string' && req.body.message.length > 0
          ? req.body.message
          : undefined;

      const planKey = res.locals.planState?.plan ?? 'free';
      const maxDocPages = getPlan(planKey).limits.maxDocPages;

      let extractedText = '';
      if (req.file) {
        const filename = req.file.originalname.toLowerCase();
        if (filename.endsWith('.pdf')) {
          const { text, pages } = await extractPdfText(new Uint8Array(req.file.buffer));
          extractedText = text;
          const pageCount = pages.length;
          if (pageCount > maxDocPages) {
            const capLabel = maxDocPages === UNLIMITED ? 'unlimited' : String(maxDocPages);
            throw new HttpError(
              402,
              `Document has ${pageCount} pages; your plan allows up to ${capLabel} pages per document.`,
            );
          }
        } else {
          extractedText = req.file.buffer.toString('utf-8');
        }
      }

      const userInput = message ?? 'Please audit the attached document.';

      const graph = await getCompiledGraph();
      const result = await graph.invoke(
        {
          messages: [new HumanMessage(userInput)],
          documentText: extractedText,
        },
        { configurable: { thread_id: namespacedThreadId } },
      );

      const lastMessage = result.messages.at(-1);
      const aiResponse = lastMessage ? asString(lastMessage.content) : '';

      res.json({ response: aiResponse, thread_id: threadId });
    } catch (err) {
      next(err);
    }
  },
);
