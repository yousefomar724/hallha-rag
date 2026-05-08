import { z } from 'zod';

export const userTypeSchema = z.enum(['business', 'auditor']);

export const businessOnboardingSchema = z.object({
  industry: z.enum(['fintech', 'realEstate', 'ecommerce', 'investment', 'lending', 'insurance', 'other']),
  targetAudience: z.enum(['b2b', 'b2c', 'b2b2c']),
  revenueModel: z.enum([
    'subscription',
    'commission',
    'markup',
    'transactionFee',
    'interestSpread',
    'other',
  ]),
  paymentMethods: z
    .array(
      z.enum(['installments', 'digitalGateways', 'cash', 'wireTransfer', 'crypto']),
    )
    .min(1),
});

export const auditorOnboardingSchema = z.object({
  specialization: z.enum(['banking', 'crypto', 'insuranceTakaful', 'capitalMarkets', 'realEstate', 'general']),
  standards: z
    .array(z.enum(['aaoifi', 'nationalLaws', 'hanafi', 'maliki', 'shafii', 'hanbali']))
    .min(1),
  useCase: z.enum(['consultantClientContracts', 'internalCompliance', 'training', 'other']),
});

/** Maps business onboarding industry enum to org `industry` string (human-readable). */
const BUSINESS_INDUSTRY_LABEL: Record<
  z.infer<typeof businessOnboardingSchema>['industry'],
  string
> = {
  fintech: 'Fintech',
  realEstate: 'Real estate',
  ecommerce: 'E-commerce',
  investment: 'Investment / asset management',
  lending: 'Lending / financing',
  insurance: 'Insurance & takaful',
  other: 'Other',
};

export function businessOnboardingIndustryLabel(
  industry: z.infer<typeof businessOnboardingSchema>['industry'],
): string {
  return BUSINESS_INDUSTRY_LABEL[industry];
}
