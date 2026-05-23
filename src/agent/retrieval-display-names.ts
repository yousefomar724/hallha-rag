import { getDb } from '../lib/mongo.js';
import {
  CLIENT_DOCUMENT_COLLECTION,
  type ClientDocumentDoc,
} from '../lib/client-documents.js';

/** Map s3Key → display label for client-doc citations. */
export async function getDisplayNamesForClientDocumentKeys(
  keys: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(keys.filter((k) => k.length > 0))];
  if (uniq.length === 0) return out;
  const db = await getDb();
  const docs = await db
    .collection<ClientDocumentDoc>(CLIENT_DOCUMENT_COLLECTION)
    .find({ s3Key: { $in: uniq } })
    .project({ s3Key: 1, displayName: 1, originalName: 1 })
    .toArray();
  for (const d of docs) {
    const k = d['s3Key'] as string;
    const display =
      (typeof d['displayName'] === 'string' && d['displayName']) ||
      (typeof d['originalName'] === 'string' && d['originalName']) ||
      '';
    if (k && display) out.set(k, display);
  }
  return out;
}
