import { describe, it, expect } from 'vitest';
import { extractStandardNumber } from '../src/utils/standard-number.js';

describe('extractStandardNumber', () => {
  it('prefers FAS/SS/GS from source filename over headings', () => {
    expect(extractStandardNumber('Chapter II > Article 5 — Riba', 'AAOIFI FAS 4.pdf')).toBe(
      'FAS 4',
    );
  });

  it('falls back to Article in headings when source has no standard code', () => {
    expect(extractStandardNumber('Section 1 > Article 7 — Riba', 'unknown.pdf')).toBe(
      'Article 7',
    );
  });
});
