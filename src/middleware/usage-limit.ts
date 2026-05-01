import type { RequestHandler } from 'express';
import { getDb } from '../lib/mongo.js';
import {
  findOrganizationDocument,
  organizationDocToPlanState,
  organizationUpdateFilter,
} from '../lib/org-billing.js';
import { checkAuditQuota } from '../lib/plans.js';
import { logger } from '../lib/logger.js';
import { HttpError } from './error.js';

/** Pre-check audit quota; register usage commit on successful response. */
export function usageLimitAudit(): RequestHandler {
  return async (req, res, next) => {
    try {
      const orgId = req.activeOrgId;
      if (!orgId) {
        throw new HttpError(500, 'Missing organization context.');
      }

      const db = await getDb();
      const orgDoc = await findOrganizationDocument(db, orgId);
      if (!orgDoc) {
        throw new HttpError(500, 'Organization not found.');
      }

      const planState = organizationDocToPlanState(orgDoc as Record<string, unknown>);
      res.locals.planState = planState;

      const quota = checkAuditQuota(planState);
      if (!quota.allowed) {
        throw new HttpError(402, quota.reason);
      }

      res.locals.auditUsage = { orgId, usePackCredit: quota.usePackCredit };

      const commit = () => {
        void (async () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            const usage = res.locals.auditUsage;
            if (!usage) return;
            const latest = await findOrganizationDocument(db, usage.orgId);
            if (!latest) return;
            const filter = organizationUpdateFilter(latest);
            if (usage.usePackCredit) {
              await db.collection('organization').updateOne(filter, {
                $inc: { usageAuditPackCredits: -1 },
              });
            } else {
              await db.collection('organization').updateOne(filter, {
                $inc: { usageAuditsThisPeriod: 1 },
              });
            }
          } catch (err) {
            logger.error({ err }, 'Failed to commit audit usage');
          }
        })();
      };
      res.once('finish', commit);
      next();
    } catch (err) {
      next(err);
    }
  };
}
