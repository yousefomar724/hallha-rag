import { ingestPdfToPinecone } from '../rag/ingest.js';
import { clientTenantNamespace } from './pinecone.js';
import { incrementClientDocumentCount } from './clients.js';
import {
  listStalePendingDocuments,
  setClientDocumentStatus,
} from './client-documents.js';
import { logger } from './logger.js';
import type { ClientDocumentType } from './client-schema.js';

/**
 * Fire-and-forget ingest. Caller has already inserted a `client_document` row with
 * status='pending' and put the file in S3; this function does the PDF→Pinecone work
 * in the background and flips the row to 'ready' or 'failed' when done.
 *
 * IMPORTANT: this function intentionally swallows errors (it logs + marks the row
 * 'failed') because it runs after the HTTP response has already been sent. The
 * frontend polls the status endpoint to see the outcome.
 */
export async function processClientDocumentIngest(opts: {
  buffer: Buffer;
  originalName: string;
  s3Key: string;
  s3Url: string;
  firmId: string;
  clientId: string;
  documentType: ClientDocumentType;
}): Promise<void> {
  const started = Date.now();
  try {
    const message = await ingestPdfToPinecone({
      buffer: opts.buffer,
      originalName: opts.originalName,
      s3Key: opts.s3Key,
      s3Url: opts.s3Url,
      namespace: clientTenantNamespace(opts.clientId),
      extraMetadata: {
        scope: 'client',
        firmId: opts.firmId,
        clientId: opts.clientId,
        documentType: opts.documentType,
      },
    });

    // ingestPdfToPinecone returns "Successfully uploaded N document chunks to Pinecone."
    // Parse N out for status reporting; non-fatal if the format changes.
    const m = /uploaded\s+(\d+)\s+document\s+chunks/i.exec(message);
    const chunkCount = m && m[1] ? Number.parseInt(m[1], 10) : null;

    await setClientDocumentStatus({
      s3Key: opts.s3Key,
      status: 'ready',
      chunkCount: Number.isFinite(chunkCount) ? chunkCount : null,
    });
    await incrementClientDocumentCount(opts.firmId, opts.clientId, 1);

    logger.info(
      { s3Key: opts.s3Key, clientId: opts.clientId, chunkCount, ms: Date.now() - started },
      'Client document ingest complete',
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, s3Key: opts.s3Key, clientId: opts.clientId, ms: Date.now() - started },
      'Client document ingest failed',
    );
    try {
      await setClientDocumentStatus({
        s3Key: opts.s3Key,
        status: 'failed',
        error: errorMessage,
      });
    } catch (markErr) {
      logger.error({ err: markErr, s3Key: opts.s3Key }, 'Failed to mark document as failed');
    }
  }
}

/**
 * Boot-time janitor: any row left in 'pending' state across a restart cannot be resumed
 * (we don't persist the buffer), so mark it failed with a user-actionable message.
 * Conservative threshold (5 min) to avoid clobbering an in-flight upload during a hot
 * restart on the same instance.
 */
export async function recoverStalePendingIngests(): Promise<{ marked: number }> {
  const STALE_MS = 5 * 60 * 1000;
  let marked = 0;
  try {
    const stale = await listStalePendingDocuments(STALE_MS);
    for (const doc of stale) {
      try {
        await setClientDocumentStatus({
          s3Key: doc.s3Key,
          status: 'failed',
          error: 'Server restarted during ingestion. Please re-upload this file.',
        });
        marked += 1;
      } catch (err) {
        logger.warn({ err, s3Key: doc.s3Key }, 'Failed to mark stale pending document');
      }
    }
    if (marked > 0) {
      logger.info({ marked }, 'Recovered stale pending client document ingests');
    }
  } catch (err) {
    logger.warn({ err }, 'Stale pending ingest recovery failed (continuing)');
  }
  return { marked };
}
