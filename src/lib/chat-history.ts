import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import { getDb } from './mongo.js';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const CHAT_THREAD_COLLECTION = 'chat_thread';

/** Threads (and the rolling Mongo TTL) auto-purge after this many seconds of inactivity. */
export const CHAT_RETENTION_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type ChatThreadDoc = {
  threadId: string; // namespaced: `${orgId}:${userThreadId}`
  userThreadId: string;
  organizationId: string;
  userId: string;
  title: string;
  lastMessageAt: Date;
  createdAt: Date;
};

export function namespaceThreadId(orgId: string, userThreadId: string): string {
  return `${orgId}:${userThreadId}`;
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
};

export async function listThreadsForUser(
  organizationId: string,
  userId: string,
  limit = 50,
): Promise<ListedThread[]> {
  const db = await getDb();
  const cursor = db
    .collection<ChatThreadDoc>(CHAT_THREAD_COLLECTION)
    .find({ organizationId, userId })
    .sort({ lastMessageAt: -1 })
    .limit(limit);
  const docs = await cursor.toArray();
  return docs.map((d) => ({
    thread_id: d.userThreadId,
    title: d.title,
    lastMessageAt: d.lastMessageAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
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
  const cpFilter: Document = { thread_id: threadId };
  const [cps, writes] = await Promise.all([
    db.collection(env.MONGO_CHECKPOINT_COLLECTION).deleteMany(cpFilter),
    db.collection(env.MONGO_CHECKPOINT_WRITES_COLLECTION).deleteMany(cpFilter),
  ]);
  return {
    threadDeleted: true,
    checkpointsDeleted: cps.deletedCount ?? 0,
    writesDeleted: writes.deletedCount ?? 0,
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
