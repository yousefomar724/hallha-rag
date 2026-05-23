import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { getDb } from './mongo.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const CHAT_THREAD_COLLECTION = 'chat_thread';

/** Threads (and the rolling Mongo TTL) auto-purge after this many seconds of inactivity. */
export const CHAT_RETENTION_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type ChatThreadDoc = {
  threadId: string; // namespaced: `${orgId}:${userThreadId}` or `${orgId}:${clientId}:${userThreadId}`
  userThreadId: string;
  organizationId: string;
  userId: string;
  /** Audited-client id when chat is scoped to a client; null for general firm chats. */
  clientId?: string | null;
  title: string;
  lastMessageAt: Date;
  createdAt: Date;
  /** Optional audit snapshot after DELETE /chats/:id/purge?keepSummary=true */
  summary?: string;
  summaryCreatedAt?: Date;
};

export function namespaceThreadId(
  orgId: string,
  userThreadId: string,
  clientId?: string | null,
): string {
  return clientId
    ? `${orgId}:${clientId}:${userThreadId}`
    : `${orgId}:${userThreadId}`;
}

function assistantMessageContentToText(content: unknown): string {
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

/** Latest assistant turn from a persisted LangGraph checkpoint, for purge/summary snapshots. */
export function getLatestAssistantMessageContent(values: {
  messages?: BaseMessage[];
}): string | null {
  const messages = values?.messages;
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (AIMessage.isInstance(m)) {
      const t = assistantMessageContentToText(m.content).trim();
      return t.length > 0 ? t : null;
    }
  }
  return null;
}

export async function deleteCheckpointsForThread(
  db: Db,
  threadId: string,
): Promise<{ checkpointsDeleted: number; writesDeleted: number }> {
  const cpFilter: Document = { thread_id: threadId };
  const [cps, writes] = await Promise.all([
    db.collection(env.MONGO_CHECKPOINT_COLLECTION).deleteMany(cpFilter),
    db.collection(env.MONGO_CHECKPOINT_WRITES_COLLECTION).deleteMany(cpFilter),
  ]);
  return {
    checkpointsDeleted: cps.deletedCount ?? 0,
    writesDeleted: writes.deletedCount ?? 0,
  };
}

export async function purgeThreadWithOptions(opts: {
  db: Db;
  organizationId: string;
  userId: string;
  userThreadId: string;
  clientId?: string | null;
  keepSummary: boolean;
  summaryText: string | null;
}): Promise<
  | { ok: false; reason: 'not_found' }
  | {
      ok: true;
      checkpointsDeleted: number;
      writesDeleted: number;
      threadDeleted: boolean;
      summarySaved: boolean;
    }
> {
  const { db, organizationId, userId, userThreadId, clientId, keepSummary, summaryText } = opts;
  const namespaced = namespaceThreadId(organizationId, userThreadId, clientId ?? null);

  const owned = await db.collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION).findOne({
    threadId: namespaced,
    organizationId,
    userId,
  });
  if (!owned) {
    return { ok: false, reason: 'not_found' };
  }

  if (!keepSummary) {
    const r = await deleteThreadAndCheckpoints({
      db,
      threadId: namespaced,
      organizationId,
      userId,
    });
    if (!r.threadDeleted) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      checkpointsDeleted: r.checkpointsDeleted,
      writesDeleted: r.writesDeleted,
      threadDeleted: true,
      summarySaved: false,
    };
  }

  const now = new Date();
  await db.collection(CHAT_THREAD_COLLECTION).updateOne(
    { threadId: namespaced, organizationId, userId },
    {
      $set: {
        summary: summaryText ?? '',
        summaryCreatedAt: now,
        lastMessageAt: now,
      },
    },
  );
  const { checkpointsDeleted, writesDeleted } = await deleteCheckpointsForThread(db, namespaced);
  return {
    ok: true,
    checkpointsDeleted,
    writesDeleted,
    threadDeleted: false,
    summarySaved: true,
  };
}

export function deriveThreadTitle(input: string | undefined | null): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return 'Untitled audit';
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  return firstLine.slice(0, 80);
}

let indexesEnsured = false;

export async function ensureChatHistoryIndexes(): Promise<void> {
  if (indexesEnsured) return;
  const db = await getDb();
  const col = db.collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION);
  await col.createIndex({ threadId: 1 }, { unique: true });
  await col.createIndex({ organizationId: 1, userId: 1, lastMessageAt: -1 });
  await col.createIndex(
    { lastMessageAt: 1 },
    { expireAfterSeconds: CHAT_RETENTION_SECONDS, name: 'chat_thread_ttl' },
  );
  indexesEnsured = true;
  logger.info({ collection: CHAT_THREAD_COLLECTION, ttlDays: 30 }, 'Chat history indexes ensured');
}

export async function upsertThreadActivity(opts: {
  threadId: string;
  userThreadId: string;
  organizationId: string;
  userId: string;
  clientId?: string | null;
  firstMessageForTitle: string | null;
}): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION).updateOne(
    { threadId: opts.threadId },
    {
      $set: {
        userThreadId: opts.userThreadId,
        organizationId: opts.organizationId,
        userId: opts.userId,
        clientId: opts.clientId ?? null,
        lastMessageAt: now,
      },
      $setOnInsert: {
        threadId: opts.threadId,
        title: deriveThreadTitle(opts.firstMessageForTitle),
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

export type ListedThread = {
  thread_id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
  clientId?: string | null;
};

export async function listThreadsForUser(
  organizationId: string,
  userId: string,
  limit = 50,
  filter: { clientId?: string | null } = {},
): Promise<ListedThread[]> {
  const db = await getDb();
  const mongoFilter: Record<string, unknown> = { organizationId, userId };
  if (filter.clientId !== undefined) {
    mongoFilter['clientId'] = filter.clientId;
  }
  const cursor = db
    .collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION)
    .find(mongoFilter)
    .sort({ lastMessageAt: -1 })
    .limit(limit);
  const docs = await cursor.toArray();
  return docs.map((d) => ({
    thread_id: d.userThreadId,
    title: d.title,
    lastMessageAt: d.lastMessageAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    clientId: d.clientId ?? null,
  }));
}

export async function findThreadOwned(opts: {
  organizationId: string;
  userId: string;
  userThreadId: string;
}): Promise<ChatThreadDoc | null> {
  const db = await getDb();
  return db.collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION).findOne({
    organizationId: opts.organizationId,
    userId: opts.userId,
    userThreadId: opts.userThreadId,
  });
}

export async function deleteThreadAndCheckpoints(opts: {
  db: Db;
  threadId: string;
  organizationId: string;
  userId: string;
}): Promise<{ threadDeleted: boolean; checkpointsDeleted: number; writesDeleted: number }> {
  const { db, threadId, organizationId, userId } = opts;
  const threadResult = await db.collection(CHAT_THREAD_COLLECTION).deleteOne({
    threadId,
    organizationId,
    userId,
  });
  if (threadResult.deletedCount === 0) {
    return { threadDeleted: false, checkpointsDeleted: 0, writesDeleted: 0 };
  }
  const del = await deleteCheckpointsForThread(db, threadId);
  return {
    threadDeleted: true,
    checkpointsDeleted: del.checkpointsDeleted,
    writesDeleted: del.writesDeleted,
  };
}

/**
 * Delete LangGraph checkpoint docs whose `thread_id` no longer has a `chat_thread` metadata row.
 * Skips docs created within the last hour to avoid racing with in-flight conversations whose
 * metadata write hasn't landed yet.
 *
 * Safe to invoke repeatedly. Single-instance friendly: in multi-instance deploys, idempotent
 * `deleteMany` calls don't conflict but you may want to confine this to one node via cron.
 */
export async function cleanupOrphanCheckpoints(): Promise<{
  scanned: number;
  orphaned: number;
  checkpointsDeleted: number;
  writesDeleted: number;
}> {
  const db = await getDb();
  const ageCutoff = ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600);
  const knownThreads = (await db
    .collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION)
    .distinct('threadId')) as string[];

  const candidateFilter: Document = {
    _id: { $lt: ageCutoff },
    thread_id: { $nin: knownThreads },
  };

  const orphanThreadIds = (await db
    .collection(env.MONGO_CHECKPOINT_COLLECTION)
    .distinct('thread_id', candidateFilter)) as string[];

  if (orphanThreadIds.length === 0) {
    return { scanned: knownThreads.length, orphaned: 0, checkpointsDeleted: 0, writesDeleted: 0 };
  }

  const [cps, writes] = await Promise.all([
    db.collection(env.MONGO_CHECKPOINT_COLLECTION).deleteMany({ thread_id: { $in: orphanThreadIds } }),
    db
      .collection(env.MONGO_CHECKPOINT_WRITES_COLLECTION)
      .deleteMany({ thread_id: { $in: orphanThreadIds } }),
  ]);

  const result = {
    scanned: knownThreads.length,
    orphaned: orphanThreadIds.length,
    checkpointsDeleted: cps.deletedCount ?? 0,
    writesDeleted: writes.deletedCount ?? 0,
  };
  logger.info(result, 'Orphan checkpoint cleanup complete');
  return result;
}
