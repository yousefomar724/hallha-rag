/**
 * Best-effort AAOIFI / regulatory label extraction for citation metadata.
 * Prefers `source` (e.g. filename) over `headings` so names like "FAS 4.pdf" win.
 */

const FAS_SS_GS_RE = /\b(FAS|SS|GS)\s*(\d+)\b/gi;

const SHARIAH_STANDARD_NO_RE = /Shari['']?ah\s+Standard\s+No\.?\s*(\d+)/i;

const ARTICLE_RE = /\bArticle\s*(\d+)\b/i;

const SECTION_RE = /\bSection\s*(\d+(?:\.\d+)*)\b/i;

function firstFasSsGs(text: string): string | undefined {
  FAS_SS_GS_RE.lastIndex = 0;
  const m = FAS_SS_GS_RE.exec(text);
  if (!m?.[1] || m[2] === undefined) return undefined;
  return `${m[1].toUpperCase()} ${m[2]}`;
}

function firstShariaStandardNo(text: string): string | undefined {
  const m = SHARIAH_STANDARD_NO_RE.exec(text);
  if (!m?.[1]) return undefined;
  return `Shariah Standard No. ${m[1]}`;
}

function firstArticle(text: string): string | undefined {
  const m = ARTICLE_RE.exec(text);
  if (!m?.[1]) return undefined;
  return `Article ${m[1]}`;
}

function firstSection(text: string): string | undefined {
  const m = SECTION_RE.exec(text);
  if (!m?.[1]) return undefined;
  return `Section ${m[1]}`;
}

function tryText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return (
    firstFasSsGs(trimmed) ??
    firstShariaStandardNo(trimmed) ??
    firstArticle(trimmed) ??
    firstSection(trimmed)
  );
}

export function extractStandardNumber(headings: string, source: string): string | undefined {
  return tryText(source) ?? tryText(headings);
}
