import { z } from 'zod';

export const CLIENT_DOCUMENT_TYPES = ['policies', 'contracts', 'financials', 'other'] as const;
export type ClientDocumentType = (typeof CLIENT_DOCUMENT_TYPES)[number];

export const clientDocumentTypeSchema = z.enum(CLIENT_DOCUMENT_TYPES);

export const createClientBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  industry: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(1000).optional(),
});

export const updateClientBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    industry: z.string().trim().min(1).max(80).nullable().optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const uploadClientDocumentBodySchema = z.object({
  documentType: clientDocumentTypeSchema,
  displayName: z.string().trim().max(200).optional(),
});

export type CreateClientBody = z.infer<typeof createClientBodySchema>;
export type UpdateClientBody = z.infer<typeof updateClientBodySchema>;
