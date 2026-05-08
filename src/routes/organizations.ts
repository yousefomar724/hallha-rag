import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { generateContextSummary } from '../agent/synthesis.js';
import { requireAuth } from '../middleware/require-auth.js';
import { HttpError } from '../middleware/error.js';
import { getDb } from '../lib/mongo.js';
import { workspaceProfileSchema } from '../lib/org-profile-schema.js';
import {
  auditorOnboardingSchema,
  businessOnboardingIndustryLabel,
  businessOnboardingSchema,
  userTypeSchema,
} from '../lib/persona-schema.js';

/** POST /organizations/me/persona */
const setPersonaBodySchema = z.object({
  userType: userTypeSchema,
});

export const organizationsRouter: Router = Router();

const ORG_COLLECTION = 'organization';

const planSchema = z.object({
  plan: z.enum(['free', 'starter', 'business', 'enterprise']),
  billing: z.enum(['monthly', 'yearly']),
});

type OrgDoc = Record<string, unknown> & { _id: ObjectId | string; id?: string };

async function loadOrgOrThrow(orgId: string): Promise<{ filter: Record<string, unknown>; doc: OrgDoc }> {
  const db = await getDb();
  const collection = db.collection<OrgDoc>(ORG_COLLECTION);
  const candidates: Record<string, unknown>[] = [{ id: orgId }, { _id: orgId }];
  if (ObjectId.isValid(orgId)) candidates.push({ _id: new ObjectId(orgId) });
  for (const filter of candidates) {
    const doc = await collection.findOne(filter);
    if (doc) return { filter, doc };
  }
  throw new HttpError(404, 'Organization not found.');
}

async function applyOrgUpdate(orgId: string, set: Record<string, unknown>): Promise<OrgDoc> {
  const db = await getDb();
  const collection = db.collection<OrgDoc>(ORG_COLLECTION);
  const { filter } = await loadOrgOrThrow(orgId);
  await collection.updateOne(filter, { $set: { ...set, updatedAt: new Date() } });
  const updated = await collection.findOne(filter);
  if (!updated) throw new HttpError(500, 'Failed to read updated organization.');
  return updated;
}

function serializeOrg(doc: OrgDoc): Record<string, unknown> {
  const { _id, ...rest } = doc;
  return { id: typeof _id === 'string' ? _id : _id?.toString?.() ?? null, ...rest };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? 'body';
    throw new HttpError(422, `Invalid ${path}: ${first?.message ?? 'invalid'}`);
  }
  return result.data;
}

organizationsRouter.get('/organizations/me', requireAuth, async (req, res, next) => {
  try {
    const { doc } = await loadOrgOrThrow(req.activeOrgId!);
    res.json({ organization: serializeOrg(doc) });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.post('/organizations/me/persona', requireAuth, async (req, res, next) => {
  try {
    const { userType } = parseBody(setPersonaBodySchema, req.body);
    const updated = await applyOrgUpdate(req.activeOrgId!, {
      userType,
      onboardingStep: 2,
    });
    res.json({ ok: true, organization: serializeOrg(updated) });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.post('/organizations/me/onboarding/business', requireAuth, async (req, res, next) => {
  try {
    const data = parseBody(businessOnboardingSchema, req.body);
    const onboardingData = { ...data } satisfies Record<string, unknown>;
    const industryLabel = businessOnboardingIndustryLabel(data.industry);
    const summary = await generateContextSummary({
      userType: 'business',
      onboardingData,
    });

    const updated = await applyOrgUpdate(req.activeOrgId!, {
      userType: 'business',
      onboardingData,
      contextSummary: summary,
      industry: industryLabel,
      onboardingStep: 3,
    });
    res.json({ ok: true, organization: serializeOrg(updated) });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.post('/organizations/me/onboarding/auditor', requireAuth, async (req, res, next) => {
  try {
    const data = parseBody(auditorOnboardingSchema, req.body);
    const onboardingData = { ...data } satisfies Record<string, unknown>;
    const summary = await generateContextSummary({
      userType: 'auditor',
      onboardingData,
    });

    const updated = await applyOrgUpdate(req.activeOrgId!, {
      userType: 'auditor',
      onboardingData,
      contextSummary: summary,
      onboardingStep: 5,
      onboardingCompleted: true,
    });
    res.json({ ok: true, organization: serializeOrg(updated) });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.patch('/organizations/me', requireAuth, async (req, res, next) => {
  try {
    const data = parseBody(workspaceProfileSchema, req.body);
    const updated = await applyOrgUpdate(req.activeOrgId!, {
      workspaceKind: data.workspaceKind,
      legalName: data.legalName,
      registrationNumber: data.registrationNumber,
      country: data.country,
      industry: data.industry,
      onboardingStep: 4,
    });
    res.json({ ok: true, organization: serializeOrg(updated) });
  } catch (err) {
    next(err);
  }
});

organizationsRouter.post('/organizations/me/plan', requireAuth, async (req, res, next) => {
  try {
    const data = parseBody(planSchema, req.body);
    const updated = await applyOrgUpdate(req.activeOrgId!, {
      plan: data.plan,
      billingCycle: data.billing,
      planStatus: 'active',
      onboardingStep: 5,
      onboardingCompleted: true,
    });
    res.json({ ok: true, organization: serializeOrg(updated) });
  } catch (err) {
    next(err);
  }
});

const onboardingSkipSchema = z.object({
  fromStep: z.number().int().min(2).max(5).optional(),
});

// Marks onboarding as complete without requiring the user to fill in every step.
// Org keeps default plan ('free') if the plan step was never submitted.
organizationsRouter.post('/organizations/me/onboarding/skip', requireAuth, async (req, res, next) => {
  try {
    const data = parseBody(onboardingSkipSchema, req.body ?? {});
    const update: Record<string, unknown> = { onboardingCompleted: true };
    if (typeof data.fromStep === 'number') update.onboardingStep = data.fromStep;
    const updated = await applyOrgUpdate(req.activeOrgId!, update);
    res.json({ ok: true, organization: serializeOrg(updated) });
  } catch (err) {
    next(err);
  }
});
