import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

type SplitOptions = {
  source: string;
  s3Key: string;
  s3Url: string;
  organizationId: string;
  maxChars?: number;
  overlap?: number;
};

const HEADING_RE = /^(#{1,3}) (.+)$/;
const PAGE_MARKER_RE = /^<!-- page: (\d+) -->$/;

export async function splitMarkdownByHeadings(
  markdown: string,
  opts: SplitOptions,
): Promise<Document[]> {
  const maxChars = opts.maxChars ?? 1800;
  const overlap = opts.overlap ?? 150;

  const lines = markdown.split('\n');
  const headingStack: (string | undefined)[] = [undefined, undefined, undefined];
  let currentPage = 1;
  let sectionStartPage = 1;
  let bodyLines: string[] = [];
  const rawSections: {
    headings: string;
    page: number;
    text: string;
  }[] = [];

  function flushSection() {
    const text = bodyLines.join('\n').trim();
    if (!text) {
      bodyLines = [];
      return;
    }
    const parts = headingStack.filter(Boolean) as string[];
    const headings = parts.join(' > ');
    rawSections.push({ headings, page: sectionStartPage, text });
    bodyLines = [];
  }

  for (const line of lines) {
    const pageMatch = PAGE_MARKER_RE.exec(line);
    if (pageMatch) {
      currentPage = Number(pageMatch[1]);
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      flushSection();

      const level = headingMatch[1]!.length; // 1, 2, or 3
      headingStack[level - 1] = headingMatch[2]!;
      for (let i = level; i < 3; i++) headingStack[i] = undefined;

      sectionStartPage = currentPage;
      continue;
    }

    if (bodyLines.length === 0 && line.trim() === '') continue;
    bodyLines.push(line);
  }
  flushSection();

  if (rawSections.length === 0) return [];

  const baseMeta = {
    source: opts.source,
    s3Key: opts.s3Key,
    s3Url: opts.s3Url,
    organizationId: opts.organizationId,
  };

  const docs: Document[] = [];

  const fallbackSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: maxChars,
    chunkOverlap: overlap,
  });

  for (const section of rawSections) {
    const meta = {
      ...baseMeta,
      page: section.page,
      headings: section.headings,
    };

    if (section.text.length <= maxChars) {
      docs.push(new Document({ pageContent: section.text, metadata: meta }));
    } else {
      const subDocs = await fallbackSplitter.splitDocuments([
        new Document({ pageContent: section.text, metadata: meta }),
      ]);
      docs.push(...subDocs);
    }
  }

  return docs;
}
