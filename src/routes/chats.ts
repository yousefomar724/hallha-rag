import { Router } from 'express';
import type { BaseMessage } from '@langchain/core/messages';
import { requireAuth } from '../middleware/require-auth.js';
import { HttpError } from '../middleware/error.js';
import { getDb } from '../lib/mongo.js';
import { getCompiledGraph } from '../agent/graph.js';
import {
  deleteThreadAndCheckpoints,
  findThreadOwned,
  getLatestAssistantMessageContent,
  listThreadsForUser,
  namespaceThreadId,
  purgeThreadWithOptions,
} from '../lib/chat-history.js';
import type { RetrievedSource } from '../agent/prompt.js';

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

function parseKeepSummaryFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

chatsRouter.get('/chats', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.activeOrgId!;
    const userId = req.user!.id;
    const rawClientId = req.query['clientId'];
    const filter: { clientId?: string | null } = {};
    if (rawClientId === 'null' || rawClientId === '') filter.clientId = null;
    else if (typeof rawClientId === 'string' && rawClientId.length > 0) filter.clientId = rawClientId;
    const threads = await listThreadsForUser(orgId, userId, 50, filter);
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

    const namespaced = namespaceThreadId(orgId, userThreadId, thread.clientId ?? null);
    const graph = await getCompiledGraph();
    const state = await graph.getState({ configurable: { thread_id: namespaced } });
    const values = state?.values as
      | { messages?: BaseMessage[]; sources?: RetrievedSource[] }
      | undefined;
    const rawMessages = values?.messages ?? [];

    const messages: ApiMessage[] = rawMessages
      .map((m) => {
        const role = mapRole(m);
        let content = messageContentToText(m.content);
        if (role === 'assistant') content = content.trim();
        return { role, content };
      })
      .filter((m) => m.role !== 'system')
      .filter((m) => m.role !== 'tool')
      .filter((m) => !(m.role === 'assistant' && m.content.length === 0));

    const sources = Array.isArray(values?.sources) ? values.sources : [];

    res.json({
      thread_id: thread.userThreadId,
      title: thread.title,
      createdAt: thread.createdAt.toISOString(),
      lastMessageAt: thread.lastMessageAt.toISOString(),
      messages,
      sources,
    });
  } catch (err) {
    next(err);
  }
});

chatsRouter.delete('/chats/:thread_id/purge', requireAuth, async (req, res, next) => {
  try {
    const orgId = req.activeOrgId!;
    const userId = req.user!.id;
    const userThreadId = String(req.params.thread_id ?? '').trim();
    if (!userThreadId) throw new HttpError(422, 'thread_id is required.');

    const thread = await findThreadOwned({ organizationId: orgId, userId, userThreadId });
    if (!thread) throw new HttpError(404, 'Chat not found.');

    const namespaced = namespaceThreadId(orgId, userThreadId, thread.clientId ?? null);
    const keepSummary = parseKeepSummaryFlag(req.query.keepSummary);

    let summaryText: string | null = null;
    if (keepSummary) {
      const graph = await getCompiledGraph();
      const state = await graph.getState({ configurable: { thread_id: namespaced } });
      const values = state?.values as { messages?: BaseMessage[] } | undefined;
      summaryText = getLatestAssistantMessageContent(values ?? {});
    }

    const db = await getDb();
    const result = await purgeThreadWithOptions({
      db,
      organizationId: orgId,
      userId,
      userThreadId,
      clientId: thread.clientId ?? null,
      keepSummary,
      summaryText,
    });

    if (!result.ok) throw new HttpError(404, 'Chat not found.');

    res.json({
      status: 'purged',
      keepSummary,
      threadDeleted: result.threadDeleted,
      summarySaved: result.summarySaved,
      checkpointsDeleted: result.checkpointsDeleted,
      writesDeleted: result.writesDeleted,
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

    const thread = await findThreadOwned({ organizationId: orgId, userId, userThreadId });
    if (!thread) throw new HttpError(404, 'Chat not found.');

    const namespaced = namespaceThreadId(orgId, userThreadId, thread.clientId ?? null);
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
