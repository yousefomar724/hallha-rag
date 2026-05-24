import type { RetrievalCandidate } from './retrieval.js';
import { extractStandardNumber } from '../utils/standard-number.js';
import { getDisplayNamesForS3Keys } from '../lib/knowledge-files.js';
import { getDisplayNamesForClientDocumentKeys } from './retrieval-display-names.js';
import type { RetrievedSource } from './prompt.js';

function basenameOnly(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'unknown';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Convert ranked Pinecone candidates into the wire-shaped `RetrievedSource[]`
 * + a formatted `context` block suitable for the system prompt.
 *
 * `startId` lets the CRAG loop assign globally-unique ids across multiple
 * per-clause retrieval calls (so citations like [4], [5] don't collide).
 */
export async function formatSourcesFromCandidates(
  ordered: RetrievalCandidate[],
  startId = 1,
): Promise<{ sources: RetrievedSource[]; context: string }> {
  if (ordered.length === 0) {
    return { sources: [], context: '' };
  }

  const globalKeys: string[] = [];
  const clientKeys: string[] = [];
  for (const c of ordered) {
    const meta = (c.doc.metadata ?? {}) as { s3Key?: unknown };
    const s3Key = typeof meta.s3Key === 'string' ? meta.s3Key : '';
    if (!s3Key) continue;
    if (c.doc.__scope === 'client') clientKeys.push(s3Key);
    else globalKeys.push(s3Key);
  }

  const [globalDisplay, clientDisplay] = await Promise.all([
    getDisplayNamesForS3Keys(globalKeys),
    getDisplayNamesForClientDocumentKeys(clientKeys),
  ]);

  const sources: RetrievedSource[] = ordered.map((c, i) => {
    const meta = (c.doc.metadata ?? {}) as {
      source?: unknown;
      page?: unknown;
      s3Url?: unknown;
      headings?: unknown;
      s3Key?: unknown;
      standard_number?: unknown;
      clientId?: unknown;
      documentType?: unknown;
    };
    const rawSource =
      typeof meta.source === 'string' && meta.source ? meta.source : 'unknown';
    const source = basenameOnly(rawSource);
    const pageNum = Number(meta.page);
    const page = Number.isFinite(pageNum) ? pageNum : 0;
    const url = typeof meta.s3Url === 'string' && meta.s3Url ? meta.s3Url : undefined;
    const headings =
      typeof meta.headings === 'string' && meta.headings ? meta.headings : undefined;
    const stdFromMeta =
      typeof meta.standard_number === 'string' && meta.standard_number.trim()
        ? meta.standard_number.trim()
        : undefined;
    const standardNumber =
      stdFromMeta ?? extractStandardNumber(headings ?? '', rawSource) ?? undefined;
    const s3Key =
      typeof meta.s3Key === 'string' && meta.s3Key.length > 0 ? meta.s3Key : undefined;
    const scope = c.doc.__scope;
    const displayName =
      (s3Key && (scope === 'client' ? clientDisplay.get(s3Key) : globalDisplay.get(s3Key))) ||
      source;
    const clientId =
      typeof meta.clientId === 'string' && meta.clientId ? meta.clientId : undefined;
    const documentType =
      meta.documentType === 'policies' ||
      meta.documentType === 'contracts' ||
      meta.documentType === 'financials' ||
      meta.documentType === 'other'
        ? meta.documentType
        : undefined;

    return {
      id: startId + i,
      type: 'document' as const,
      source,
      displayName,
      page,
      scope,
      ...(url ? { url } : {}),
      ...(headings ? { headings } : {}),
      ...(standardNumber ? { standardNumber } : {}),
      ...(clientId ? { clientId } : {}),
      ...(documentType ? { documentType } : {}),
    };
  });

  const context = ordered
    .map((c: RetrievalCandidate, i) => {
      const s = sources[i]!;
      const scopeTag = s.scope === 'client' ? 'CLIENT DOCUMENT' : 'AAOIFI / GLOBAL';
      const std = s.standardNumber?.trim() || '—';
      const page = Number.isFinite(s.page) && s.page > 0 ? String(s.page) : '?';
      const section = s.headings?.trim() || '—';
      const label = s.displayName?.trim() || s.source;
      const header = `[${s.id}] (${scopeTag}) ${label} — standard: ${std} — p.${page} — § ${section}`;
      return `${header}\n${c.doc.pageContent}`;
    })
    .join('\n\n');

  return { sources, context };
}
