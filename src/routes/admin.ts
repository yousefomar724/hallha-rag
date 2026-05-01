import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireSuperadmin } from '../middleware/require-admin.js';
import { HttpError } from '../middleware/error.js';
import { getDb } from '../lib/mongo.js';
import { getPineconeClient } from '../lib/pinecone.js';
import { env } from '../config/env.js';

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
