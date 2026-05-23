import { Router } from 'express';
import { memoryUpload } from '../middleware/upload.js';
import { ingestPdfToPinecone } from '../rag/ingest.js';
import { putGlobalAaoifiObject } from '../lib/s3.js';
import { recordKnowledgeFile } from '../lib/knowledge-files.js';
import { HttpError } from '../middleware/error.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { uploadKnowledgeDailyLimiter } from '../middleware/rate-limit.js';
import { GLOBAL_AAOIFI_NAMESPACE } from '../lib/pinecone.js';
import { logger } from '../lib/logger.js';

export const uploadKnowledgeRouter: Router = Router();

/**
 * Upload an AAOIFI / global standards PDF.
 * Stored under `uploads/global/aaoifi/<uuid>-<filename>` in S3 and ingested
 * into the `global_aaoifi` Pinecone namespace — shared across all firms.
 */
uploadKnowledgeRouter.post(
  '/upload-knowledge',
  requireAdmin,
  uploadKnowledgeDailyLimiter,
  memoryUpload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer || req.file.buffer.length === 0) {
        throw new HttpError(400, 'Missing required field "file".');
      }

      const rawDisplayName =
        typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
      const displayName = rawDisplayName || req.file.originalname;

      const { key, url } = await putGlobalAaoifiObject(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );

      const message = await ingestPdfToPinecone({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        s3Key: key,
        s3Url: url,
        namespace: GLOBAL_AAOIFI_NAMESPACE,
        extraMetadata: { scope: 'global' },
      });

      try {
        // organizationId is retained as the uploading firm (auditing firm) — useful for
        // attribution, but retrieval no longer filters on it (global namespace = shared).
        await recordKnowledgeFile({
          s3Key: key,
          organizationId: req.activeOrgId!,
          originalName: req.file.originalname,
          displayName,
          uploadedAt: new Date(),
          uploadedBy: req.user!.id,
          sizeBytes: req.file.size ?? 0,
        });
      } catch (err) {
        logger.warn(
          { err, key },
          'Failed to record knowledge file metadata (S3/Pinecone already committed)',
        );
      }

      res.json({
        status: 'success',
        message,
        source: { name: req.file.originalname, displayName, key, url },
      });
    } catch (err) {
      next(err);
    }
  },
);
