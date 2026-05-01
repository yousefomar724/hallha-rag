import { describe, it, expect } from 'vitest';
import { workspaceProfileSchema } from '../src/lib/org-profile-schema.js';

describe('workspaceProfileSchema', () => {
  it('accepts individual with empty registrationNumber', () => {
    const r = workspaceProfileSchema.safeParse({
      workspaceKind: 'individual',
      legalName: 'Jane Freelancer',
      registrationNumber: '',
      country: 'ae',
      industry: 'services',
    });
    expect(r.success).toBe(true);
  });

  it('rejects business with empty registrationNumber', () => {
    const r = workspaceProfileSchema.safeParse({
      workspaceKind: 'business',
      legalName: 'Acme LLC',
      registrationNumber: '',
      country: 'ae',
      industry: 'tech',
    });
    expect(r.success).toBe(false);
  });

  it('accepts business with registrationNumber', () => {
    const r = workspaceProfileSchema.safeParse({
      workspaceKind: 'business',
      legalName: 'Acme LLC',
      registrationNumber: 'CR-123',
      country: 'ae',
      industry: 'tech',
    });
    expect(r.success).toBe(true);
  });
});
