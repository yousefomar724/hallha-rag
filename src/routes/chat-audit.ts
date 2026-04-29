import { Router } from 'express';
import { HumanMessage } from '@langchain/core/messages';
import { memoryUpload } from '../middleware/upload.js';
import { HttpError } from '../middleware/error.js';
import { extractPdfText } from '../utils/pdf.js';
import { getCompiledGraph } from '../agent/graph.js';

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

chatAuditRouter.post('/chat-audit', memoryUpload.single('file'), async (req, res, next) => {
  try {
    const threadId = typeof req.body?.thread_id === 'string' ? req.body.thread_id.trim() : '';
    if (!threadId) {
      throw new HttpError(422, 'thread_id is required.');
    }
    const message: string | undefined =
      typeof req.body?.message === 'string' && req.body.message.length > 0
        ? req.body.message
        : undefined;

    let extractedText = '';
    if (req.file) {
      const filename = req.file.originalname.toLowerCase();
      if (filename.endsWith('.pdf')) {
        const { text } = await extractPdfText(new Uint8Array(req.file.buffer));
        extractedText = text;
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
      { configurable: { thread_id: threadId } },
    );

    const lastMessage = result.messages.at(-1);
    const aiResponse = lastMessage ? asString(lastMessage.content) : '';

    res.json({ response: aiResponse, thread_id: threadId });
  } catch (err) {
    next(err);
  }
});
