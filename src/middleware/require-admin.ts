import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import { requireAuth } from './require-auth.js';
import { HttpError } from './error.js';
import { getDb } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';

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
        logger.warn(
          { userId, email: req.user?.email, role, path: req.path },
          'Admin access denied',
        );
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
        logger.warn(
          { userId, email: req.user?.email, role, path: req.path },
          'Superadmin access denied',
        );
        return next(new HttpError(403, 'Superadmin access required.'));
      }
      req.user = { ...req.user!, role };
      next();
    }).catch(next);
  });
};
