import { createRequire } from 'node:module';
import { IngestError } from '../rag/ingest.js';

const require = createRequire(import.meta.url);
const pdf2md = require('@opendocsg/pdf2md') as (
  buf: Uint8Array | ArrayBuffer,
) => Promise<string>;

export async function extractPdfMarkdown(
  buffer: Uint8Array,
): Promise<{ markdown: string; pageCount: number }> {
  let raw: string;
  try {
    raw = await pdf2md(buffer);
  } catch {
    throw new IngestError(
      'Could not convert PDF to Markdown. The file may be corrupted or not a real PDF.',
    );
  }

  if (!raw || !raw.trim()) {
    throw new IngestError('PDF produced no extractable text.');
  }

  const pageParts = raw.split('<!-- PAGE_BREAK -->');
  const pageCount = pageParts.length;

  const markdown = pageParts
    .map((part, i) => `<!-- page: ${i + 1} -->\n${part}`)
    .join('\n');

  return { markdown, pageCount };
}
