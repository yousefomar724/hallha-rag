import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { requireAuth } from './require-auth.js';
import { HttpError } from './error.js';
import { getDb } from '../lib/mongo.js';

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

async function fetchUserRole(userId: string): Promise<string | null> {
  const db = await getDb();
  const filter = ObjectId.isValid(userId)
    ? { $or: [{ id: userId }, { _id: new ObjectId(userId) }] }
    : { id: userId };
  const doc = await db.collection('user').findOne(filter);
  return typeof doc?.role === 'string' ? doc.role : null;
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    const userId = req.user?.id;
    if (!userId) return next(new HttpError(403, 'Admin access required.'));

    void fetchUserRole(userId).then((role) => {
      if (!role || !ADMIN_ROLES.has(role)) {
        return next(new HttpError(403, 'Admin access required.'));
      }
      req.user = { ...req.user!, role };
      next();
    }).catch(next);
  });
};

export const requireSuperadmin: RequestHandler = (req, res, next) => {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    const userId = req.user?.id;
    if (!userId) return next(new HttpError(403, 'Superadmin access required.'));

    void fetchUserRole(userId).then((role) => {
      if (role !== 'superadmin') {
        return next(new HttpError(403, 'Superadmin access required.'));
      }
      req.user = { ...req.user!, role };
      next();
    }).catch(next);
  });
};
