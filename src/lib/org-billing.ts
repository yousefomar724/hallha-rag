import type { Db, Document } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { OrgPlanState, PlanKey } from './plans.js';

const ORG_COLLECTION = 'organization';

export async function findOrganizationDocument(db: Db, orgId: string): Promise<Document | null> {
  const byIdField = await db.collection(ORG_COLLECTION).findOne({ id: orgId });
  if (byIdField) return byIdField;
  if (ObjectId.isValid(orgId)) {
    const byOid = await db.collection(ORG_COLLECTION).findOne({ _id: new ObjectId(orgId) });
    if (byOid) return byOid;
  }
  return null;
}

export function organizationDocToPlanState(doc: Record<string, unknown>): OrgPlanState {
  const raw = doc.plan;
  const planKeys: PlanKey[] = ['free', 'starter', 'business', 'enterprise'];
  const plan: PlanKey =
    typeof raw === 'string' && (planKeys as readonly string[]).includes(raw) ? (raw as PlanKey) : 'free';
  return {
    plan,
    usage: {
      auditsThisPeriod: Number(doc.usageAuditsThisPeriod ?? 0),
      auditPackCredits: Number(doc.usageAuditPackCredits ?? 0),
    },
  };
}

export function organizationUpdateFilter(doc: Document): Record<string, unknown> {
  if (typeof doc.id === 'string') return { id: doc.id };
  return { _id: doc._id };
}
