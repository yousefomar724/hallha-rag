import { z } from 'zod';

export const workspaceKindSchema = z.enum(['individual', 'business']);

/** PATCH /organizations/me — registration required only for business workspaces */
export const workspaceProfileSchema = z
  .object({
    workspaceKind: workspaceKindSchema,
    legalName: z.string().trim().min(2),
    registrationNumber: z.string().trim(),
    country: z.string().trim().min(2),
    industry: z.string().trim().min(1),
  })
  .superRefine((data, ctx) => {
    if (data.workspaceKind === 'business' && data.registrationNumber.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'String must contain at least 1 character(s)',
        path: ['registrationNumber'],
      });
    }
  });

export type WorkspaceProfileInput = z.infer<typeof workspaceProfileSchema>;
