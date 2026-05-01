import { describe, it, expect } from 'vitest';
import { splitMarkdownByHeadings } from '../src/utils/markdown-header-splitter.js';

const BASE_OPTS = {
  source: 'test.pdf',
  s3Key: 'knowledge/test/test.pdf',
  s3Url: 'https://example.com/test.pdf',
  organizationId: 'org-1',
};

describe('splitMarkdownByHeadings', () => {
  it('splits at ## boundaries with correct heading path', async () => {
    const md = [
      '## Article 1 — Riba',
      'Riba is prohibited in all forms.',
      '',
      '## Article 2 — Gharar',
      'Excessive uncertainty invalidates a contract.',
    ].join('\n');

    const docs = await splitMarkdownByHeadings(md, BASE_OPTS);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.metadata.headings).toBe('Article 1 — Riba');
    expect(docs[0]!.pageContent).toBe('Riba is prohibited in all forms.');
    expect(docs[1]!.metadata.headings).toBe('Article 2 — Gharar');
    expect(docs[1]!.pageContent).toBe('Excessive uncertainty invalidates a contract.');
  });

  it('produces nested heading paths for # > ## > ###', async () => {
    const md = [
      '# Chapter I',
      '## Section A',
      '### Clause 1',
      'Content of clause 1.',
    ].join('\n');

    const docs = await splitMarkdownByHeadings(md, BASE_OPTS);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.headings).toBe('Chapter I > Section A > Clause 1');
  });

  it('populates metadata.page from <!-- page: N --> markers', async () => {
    const md = [
      '<!-- page: 1 -->',
      '## Intro',
      'Page one content.',
      '<!-- page: 2 -->',
      '## Details',
      'Page two content.',
    ].join('\n');

    const docs = await splitMarkdownByHeadings(md, BASE_OPTS);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.metadata.page).toBe(1);
    expect(docs[1]!.metadata.page).toBe(2);
  });

  it('falls back to size-based splitting for oversized sections', async () => {
    const longBody = 'A'.repeat(5000);
    const md = `## Big Section\n${longBody}`;

    const docs = await splitMarkdownByHeadings(md, { ...BASE_OPTS, maxChars: 1800, overlap: 150 });
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) {
      expect(doc.metadata.headings).toBe('Big Section');
      expect(doc.pageContent.length).toBeLessThanOrEqual(1800);
    }
  });

  it('handles markdown with no headings via fallback', async () => {
    const longText = 'B'.repeat(4000);

    const docs = await splitMarkdownByHeadings(longText, { ...BASE_OPTS, maxChars: 1800 });
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) {
      expect(doc.metadata.headings).toBe('');
    }
  });

  it('drops empty sections', async () => {
    const md = ['## Empty', '', '', '## Real', 'Content here.'].join('\n');

    const docs = await splitMarkdownByHeadings(md, BASE_OPTS);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.metadata.headings).toBe('Real');
  });

  it('resets deeper heading levels when a shallower heading appears', async () => {
    const md = [
      '# Part A',
      '## Sub 1',
      '### Detail X',
      'X text.',
      '# Part B',
      '## Sub 2',
      'Y text.',
    ].join('\n');

    const docs = await splitMarkdownByHeadings(md, BASE_OPTS);
    expect(docs).toHaveLength(2);
    expect(docs[0]!.metadata.headings).toBe('Part A > Sub 1 > Detail X');
    expect(docs[1]!.metadata.headings).toBe('Part B > Sub 2');
  });

  it('preserves base metadata fields on all chunks', async () => {
    const md = '## Test\nContent.';
    const docs = await splitMarkdownByHeadings(md, BASE_OPTS);
    expect(docs[0]!.metadata.source).toBe('test.pdf');
    expect(docs[0]!.metadata.s3Key).toBe('knowledge/test/test.pdf');
    expect(docs[0]!.metadata.s3Url).toBe('https://example.com/test.pdf');
    expect(docs[0]!.metadata.organizationId).toBe('org-1');
  });

  it('returns empty array for empty input', async () => {
    const docs = await splitMarkdownByHeadings('', BASE_OPTS);
    expect(docs).toHaveLength(0);
  });
});
