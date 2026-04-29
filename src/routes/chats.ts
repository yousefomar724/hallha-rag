import { Router } from 'express';
import type { BaseMessage } from '@langchain/core/messages';
import { requireAuth } from '../middleware/require-auth.js';
import { HttpError } from '../middleware/error.js';
import { getDb } from '../lib/mongo.js';
import { getCompiledGraph } from '../agent/graph.js';
import {
  deleteThreadAndCheckpoints,
  findThreadOwned,
  listThreadsForUser,
  namespaceThreadId,
} from '../lib/chat-history.js';

export const chatsRouter: Router = Router();

type ApiMessage = { role: 'user' | 'assistant' | 'system' | 'tool'; content: string };

function messageContentToText(content: unknown): string {
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

function mapRole(msg: BaseMessage): ApiMessage['role'] {
  const t = (msg as { _getType?: () => string })._getType?.() ?? '';
  if (t === 'human') return 'user';
  if (t === 'ai') return 'assistant';
  if (t === 'tool') return 'tool';
  return 'system';
}

chatsRouter.get('/chats', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.activeOrgId!;
    const userId = req.user!.id;
    const threads = await listThreadsForUser(orgId, userId);
    res.json({ threads });
  } catch (err) {
    next(err);
  }
});

chatsRouter.get('/chats/:thread_id', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.activeOrgId!;
    const userId = req.user!.id;
    const userThreadId = String(req.params.thread_id ?? '').trim();
    if (!userThreadId) throw new HttpError(422, 'thread_id is required.');

    const thread = await findThreadOwned({ organizationId: orgId, userId, userThreadId });
    if (!thread) throw new HttpError(404, 'Chat not found.');

    const namespaced = namespaceThreadId(orgId, userThreadId);
    const graph = await getCompiledGraph();
    const state = await graph.getState({ configurable: { thread_id: namespaced } });
    const rawMessages = (state?.values as { messages?: BaseMessage[] } | undefined)?.messages ?? [];

    const messages: ApiMessage[] = rawMessages
      .map((m) => ({ role: mapRole(m), content: messageContentToText(m.content) }))
      .filter((m) => m.role !== 'system');

    res.json({
      thread_id: thread.userThreadId,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      lastMessageAt: thread.lastMessageAt.toISOString(),
      messages,
    });
  } catch (err) {
    next(err);
  }
});

chatsRouter.delete('/chats/:thread_id', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.activeOrgId!;
    const userId = req.user!.id;
    const userThreadId = String(req.params.thread_id ?? '').trim();
    if (!userThreadId) throw new HttpError(422, 'thread_id is required.');

    const namespaced = namespaceThreadId(orgId, userThreadId);
    const db = await getDb();
    const result = await deleteThreadAndCheckpoints({
      db,
      threadId: namespaced,
      organizationId: orgId,
      userId,
    });
    if (!result.threadDeleted) throw new HttpError(404, 'Chat not found.');

    res.json({ status: 'deleted', ...result });
  } catch (err) {
    next(err);
  }
});
