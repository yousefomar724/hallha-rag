export type PlanKey = 'free' | 'starter' | 'business' | 'enterprise';

export type PlanLimits = {
  monthlyAudits: number;
  maxDocPages: number;
  maxSeats: number;
  customKnowledgeBase: boolean;
  apiAccess: boolean;
};

export type PlanDefinition = {
  key: PlanKey;
  name: string;
  priceUsd: number | null;
  limits: PlanLimits;
};

export const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLANS: Record<PlanKey, PlanDefinition> = {
  free: {
    key: 'free',
    name: 'Free',
    priceUsd: 0,
    limits: {
      monthlyAudits: 5,
      maxDocPages: 10,
      maxSeats: 1,
      customKnowledgeBase: false,
      apiAccess: false,
    },
  },
  starter: {
    key: 'starter',
    name: 'Starter',
    priceUsd: 29,
    limits: {
      monthlyAudits: 50,
      maxDocPages: 50,
      maxSeats: 1,
      customKnowledgeBase: false,
      apiAccess: false,
    },
  },
  business: {
    key: 'business',
    name: 'Business',
    priceUsd: 99,
    limits: {
      monthlyAudits: 250,
      maxDocPages: UNLIMITED,
      maxSeats: 3,
      customKnowledgeBase: true,
      apiAccess: false,
    },
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    priceUsd: null,
    limits: {
      monthlyAudits: UNLIMITED,
      maxDocPages: UNLIMITED,
      maxSeats: UNLIMITED,
      customKnowledgeBase: true,
      apiAccess: true,
    },
  },
};

export type OrgUsage = {
  auditsThisPeriod: number;
  auditPackCredits: number;
};

export type OrgPlanState = {
  plan: PlanKey;
  usage: OrgUsage;
};

export function getPlan(key: string | null | undefined): PlanDefinition {
  if (key && key in PLANS) return PLANS[key as PlanKey];
  return PLANS.free;
}

export type AuditQuotaCheck =
  | { allowed: true; usePackCredit: boolean }
  | { allowed: false; reason: string };

export function checkAuditQuota(org: OrgPlanState): AuditQuotaCheck {
  const limits = getPlan(org.plan).limits;
  if (org.usage.auditsThisPeriod < limits.monthlyAudits) {
    return { allowed: true, usePackCredit: false };
  }
  if (org.usage.auditPackCredits > 0) {
    return { allowed: true, usePackCredit: true };
  }
  return {
    allowed: false,
    reason: `Monthly audit limit reached for the ${getPlan(org.plan).name} plan. Upgrade or purchase an Audit Pack to continue.`,
  };
}

export function canUploadCustomKnowledge(planKey: PlanKey): boolean {
  return getPlan(planKey).limits.customKnowledgeBase;
}
