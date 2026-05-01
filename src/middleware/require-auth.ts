import type { RequestHandler } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { getDb } from '../lib/mongo.js';
import { findMemberByUserId, readOrganizationIdFromMember } from '../lib/member-lookup.js';
import { HttpError } from './error.js';

async function resolveActiveOrganizationId(
  userId: string,
  sessionActiveOrgId: string | null | undefined,
): Promise<string | null> {
  if (sessionActiveOrgId) return sessionActiveOrgId;
  const db = await getDb();
  const member = await findMemberByUserId(db, userId);
  return readOrganizationIdFromMember(member);
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const sessionData = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!sessionData?.user || !sessionData?.session) {
      throw new HttpError(401, 'Authentication required.');
    }

    const activeOrgId = await resolveActiveOrganizationId(
      sessionData.user.id,
      sessionData.session.activeOrganizationId,
    );
    if (!activeOrgId) {
      throw new HttpError(
        403,
        'No organization found for this account. Complete signup or contact support.',
      );
    }

    req.user = {
      id: sessionData.user.id,
      email: sessionData.user.email,
      name: sessionData.user.name,
      role: (sessionData.user as { role?: string | null }).role ?? null,
    };
    req.authSession = {
      id: sessionData.session.id,
      token: sessionData.session.token,
      activeOrganizationId: sessionData.session.activeOrganizationId ?? activeOrgId,
    };
    req.activeOrgId = activeOrgId;
    next();
  } catch (err) {
    next(err);
  }
};
