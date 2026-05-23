import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireSuperadmin } from '../middleware/require-admin.js';
import { HttpError } from '../middleware/error.js';
import { getDb } from '../lib/mongo.js';
import { getPineconeClient } from '../lib/pinecone.js';
import { env } from '../config/env.js';
import {
  listKnowledgeObjects,
  listGlobalAaoifiObjects,
  deleteKnowledgeObject,
  displayNameFromObjectKey,
  GLOBAL_AAOIFI_S3_PREFIX,
} from '../lib/s3.js';
import { deleteKnowledgeVectorsByS3Key } from '../rag/delete-knowledge.js';
import { GLOBAL_AAOIFI_NAMESPACE } from '../lib/pinecone.js';
import {
  deleteKnowledgeFileByS3Key,
  getKnowledgeFileMetaForKeys,
} from '../lib/knowledge-files.js';
import {
  CLIENT_COLLECTION,
  type ClientDoc,
} from '../lib/clients.js';
import { CLIENT_DOCUMENT_COLLECTION } from '../lib/client-documents.js';

export const adminRouter: Router = Router();

adminRouter.get('/admin/stats', requireAdmin, async (_req, res, next) => {
  try {
    const db = await getDb();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [totalUsers, newUsers30d, totalOrgs, planGroups, onboardedCount, totalAudits] =
      await Promise.all([
        db.collection('user').countDocuments(),
        db.collection('user').countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
        db.collection('organization').countDocuments(),
        db
          .collection('organization')
          .aggregate<{ _id: string; count: number }>([
            { $group: { _id: '$plan', count: { $sum: 1 } } },
          ])
          .toArray(),
        db.collection('organization').countDocuments({ onboardingCompleted: true }),
        db
          .collection('organization')
          .aggregate<{ total: number }>([
            {
              $group: {
                _id: null,
                total: { $sum: { $ifNull: ['$usageAuditsThisPeriod', 0] } },
              },
            },
          ])
          .toArray(),
      ]);

    const byPlan: Record<string, number> = { free: 0, starter: 0, business: 0, enterprise: 0 };
    for (const { _id, count } of planGroups) {
      const key = _id ?? 'free';
      byPlan[key] = count;
    }

    let knowledgeChunks: number | null = null;
    try {
      const pinecone = getPineconeClient();
      const idx = pinecone.Index(env.PINECONE_INDEX);
      const stats = await idx.describeIndexStats();
      knowledgeChunks = stats.totalRecordCount ?? null;
    } catch {
      // non-fatal: Pinecone may not be available in all envs
    }

    res.json({
      users: { total: totalUsers, last30d: newUsers30d },
      organizations: { total: totalOrgs, byPlan, onboardingCompleted: onboardedCount },
      audits: { currentPeriodTotal: totalAudits[0]?.total ?? 0 },
      knowledgeChunks,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/admin/knowledge-files', requireAdmin, async (req, res, next) => {
  try {
    const raw = (req.body as { key?: unknown })?.key;
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) {
      throw new HttpError(400, 'Missing required field "key".');
    }
    if (key.includes('..')) {
      throw new HttpError(400, 'Invalid knowledge object key.');
    }

    const organizationId = req.activeOrgId!;
    const legacyPrefix = `knowledge/${organizationId}/`;
    const isLegacy = key.startsWith(legacyPrefix) && key.length > legacyPrefix.length;
    const isGlobal = key.startsWith(GLOBAL_AAOIFI_S3_PREFIX) && key.length > GLOBAL_AAOIFI_S3_PREFIX.length;
    if (!isLegacy && !isGlobal) {
      throw new HttpError(403, 'Invalid knowledge object key for this organization.');
    }

    // Vector namespace depends on where the file was ingested:
    //   - legacy `knowledge/{orgId}/...` was ingested into the empty namespace
    //   - new `uploads/global/aaoifi/...` lives in GLOBAL_AAOIFI_NAMESPACE
    const namespace = isGlobal ? GLOBAL_AAOIFI_NAMESPACE : '';

    await deleteKnowledgeVectorsByS3Key(key, namespace);
    await deleteKnowledgeObject(key);
    await deleteKnowledgeFileByS3Key(key);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/admin/knowledge-files', requireAdmin, async (req, res, next) => {
  try {
    const organizationId = req.activeOrgId!;
    const continuationToken =
      typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    // Global AAOIFI uploads now live under `uploads/global/aaoifi/`. Older uploads
    // remain under `knowledge/{orgId}/`; merge both so admins can still manage them.
    const [globalRes, legacyRes] = await Promise.all([
      listGlobalAaoifiObjects({ continuationToken }),
      listKnowledgeObjects(organizationId),
    ]);
    const items = [...globalRes.items, ...legacyRes.items].sort((a, b) =>
      b.lastModified.localeCompare(a.lastModified),
    );
    const meta = await getKnowledgeFileMetaForKeys(items.map((i) => i.key));
    const merged = items.map((item) => {
      const m = meta.get(item.key);
      const originalName =
        m?.originalName?.trim()?.length ? m.originalName : item.name;
      const displayName =
        m?.displayName?.trim()?.length ? m.displayName : displayNameFromObjectKey(item.key);
      return {
        ...item,
        name: originalName,
        displayName,
      };
    });
    res.json({
      items: merged,
      nextCursor: globalRes.nextContinuationToken,
      hasMore: globalRes.nextContinuationToken !== null,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/admin/organizations', requireAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const limit = Math.min(Number(req.query['limit'] ?? 20), 100);
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const plan = typeof req.query['plan'] === 'string' ? req.query['plan'] : undefined;
    const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;

    const filter: Record<string, unknown> = {};
    if (plan) filter['plan'] = plan;
    if (cursor) filter['_id'] = { $gt: new ObjectId(cursor) };
    if (search) filter['name'] = { $regex: search, $options: 'i' };

    const orgs = await db
      .collection('organization')
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .project({
        _id: 1,
        id: 1,
        name: 1,
        plan: 1,
        planStatus: 1,
        usageAuditsThisPeriod: 1,
        onboardingCompleted: 1,
        createdAt: 1,
      })
      .toArray();

    const hasMore = orgs.length > limit;
    const items = orgs.slice(0, limit);
    const nextCursor = hasMore ? String(items[items.length - 1]?._id) : null;

    res.json({ items, nextCursor, hasMore });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/admin/organizations/:id', requireAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const id = req.params['id'] as string;

    const org = await db.collection('organization').findOne({
      $or: [
        { id },
        ...(ObjectId.isValid(id) ? [{ _id: new ObjectId(id) }] : []),
      ],
    });
    if (!org) throw new HttpError(404, 'Organization not found.');

    const orgId = (org.id as string | undefined) ?? String(org._id);

    const [memberCount, recentThreads] = await Promise.all([
      db.collection('member').countDocuments({ organizationId: orgId }),
      db
        .collection('chat_thread')
        .find({ organizationId: orgId })
        .sort({ lastMessageAt: -1 })
        .limit(5)
        .project({ threadId: 1, title: 1, lastMessageAt: 1, createdAt: 1 })
        .toArray(),
    ]);

    res.json({ org, memberCount, recentThreads });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const limit = Math.min(Number(req.query['limit'] ?? 20), 100);
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;
    const role = typeof req.query['role'] === 'string' ? req.query['role'] : undefined;

    const filter: Record<string, unknown> = {};
    if (role) filter['role'] = role;
    if (cursor) filter['_id'] = { $gt: new ObjectId(cursor) };
    if (search) {
      filter['$or'] = [
        { email: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await db
      .collection('user')
      .find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .project({ _id: 1, id: 1, name: 1, email: 1, role: 1, banned: 1, createdAt: 1, emailVerified: 1 })
      .toArray();

    const hasMore = users.length > limit;
    const items = users.slice(0, limit);
    const nextCursor = hasMore ? String(items[items.length - 1]?._id) : null;

    res.json({ items, nextCursor, hasMore });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/admin/users/:id/role', requireSuperadmin, async (req, res, next) => {
  try {
    const id = req.params['id'] as string;
    const { role } = req.body as { role?: string };
    if (!role || !['user', 'admin', 'superadmin'].includes(role)) {
      throw new HttpError(400, 'role must be one of: user, admin, superadmin');
    }

    const db = await getDb();
    const filter = ObjectId.isValid(id) ? { $or: [{ id }, { _id: new ObjectId(id) }] } : { id };
    const result = await db.collection('user').updateOne(filter, { $set: { role } });
    if (result.matchedCount === 0) throw new HttpError(404, 'User not found.');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/admin/users/:id/ban', requireSuperadmin, async (req, res, next) => {
  try {
    const id = req.params['id'] as string;
    const { reason, expiresIn } = req.body as { reason?: string; expiresIn?: number };

    const db = await getDb();
    const filter = ObjectId.isValid(id) ? { $or: [{ id }, { _id: new ObjectId(id) }] } : { id };
    const banExpires = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    const result = await db.collection('user').updateOne(filter, {
      $set: { banned: true, banReason: reason ?? null, banExpires },
    });
    if (result.matchedCount === 0) throw new HttpError(404, 'User not found.');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Superadmin-facing audited-clients overview (read-only).
 * Joins client records to their owning firm (org) for display.
 */
adminRouter.get('/admin/audited-clients', requireAdmin, async (req, res, next) => {
  try {
    const db = await getDb();
    const limit = Math.min(Number(req.query['limit'] ?? 20), 100);
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;
    const firmId = typeof req.query['firmId'] === 'string' ? req.query['firmId'] : undefined;

    const filter: Record<string, unknown> = {};
    if (firmId) filter['organizationId'] = firmId;
    if (search) filter['name'] = { $regex: search, $options: 'i' };
    if (cursor && ObjectId.isValid(cursor)) filter['_id'] = { $lt: new ObjectId(cursor) };

    const clients = await db
      .collection<ClientDoc>(CLIENT_COLLECTION)
      .find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = clients.length > limit;
    const items = clients.slice(0, limit);
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!._id.toHexString() : null;

    const firmIds = [...new Set(items.map((c) => c.organizationId))];
    const orgs = firmIds.length
      ? await db
          .collection('organization')
          .find({
            $or: [
              { id: { $in: firmIds } },
              ...(firmIds.filter(ObjectId.isValid).length
                ? [{ _id: { $in: firmIds.filter(ObjectId.isValid).map((s) => new ObjectId(s)) } }]
                : []),
            ],
          })
          .project({ _id: 1, id: 1, name: 1 })
          .toArray()
      : [];
    const orgNameById = new Map<string, string>();
    for (const o of orgs) {
      const key = (o['id'] as string | undefined) ?? String(o['_id']);
      orgNameById.set(key, (o['name'] as string | undefined) ?? key);
    }

    res.json({
      items: items.map((c) => ({
        id: c.id,
        organizationId: c.organizationId,
        organizationName: orgNameById.get(c.organizationId) ?? c.organizationId,
        name: c.name,
        industry: c.industry,
        documentCount: c.documentCount,
        archivedAt: c.archivedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
      nextCursor,
      hasMore,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/admin/audited-clients/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = req.params['id'] as string;
    const db = await getDb();
    const filter: Record<string, unknown> = ObjectId.isValid(id)
      ? { $or: [{ id }, { _id: new ObjectId(id) }] }
      : { id };
    const client = await db.collection<ClientDoc>(CLIENT_COLLECTION).findOne(filter);
    if (!client) throw new HttpError(404, 'Client not found.');

    const [docCount, recentThreads] = await Promise.all([
      db
        .collection(CLIENT_DOCUMENT_COLLECTION)
        .countDocuments({ organizationId: client.organizationId, clientId: client.id }),
      db
        .collection('chat_thread')
        .find({ organizationId: client.organizationId, clientId: client.id })
        .sort({ lastMessageAt: -1 })
        .limit(5)
        .project({ threadId: 1, title: 1, lastMessageAt: 1, createdAt: 1 })
        .toArray(),
    ]);

    const orgFilter: Record<string, unknown> = ObjectId.isValid(client.organizationId)
      ? { $or: [{ id: client.organizationId }, { _id: new ObjectId(client.organizationId) }] }
      : { id: client.organizationId };
    const org = await db.collection('organization').findOne(orgFilter);

    res.json({
      client: {
        id: client.id,
        organizationId: client.organizationId,
        organizationName: (org?.['name'] as string | undefined) ?? client.organizationId,
        name: client.name,
        industry: client.industry,
        description: client.description,
        documentCount: docCount,
        archivedAt: client.archivedAt?.toISOString() ?? null,
        createdAt: client.createdAt.toISOString(),
        updatedAt: client.updatedAt.toISOString(),
      },
      recentThreads,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/admin/users/:id/unban', requireSuperadmin, async (req, res, next) => {
  try {
    const id = req.params['id'] as string;

    const db = await getDb();
    const filter = ObjectId.isValid(id) ? { $or: [{ id }, { _id: new ObjectId(id) }] } : { id };
    const result = await db.collection('user').updateOne(filter, {
      $set: { banned: false, banReason: null, banExpires: null },
    });
    if (result.matchedCount === 0) throw new HttpError(404, 'User not found.');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
