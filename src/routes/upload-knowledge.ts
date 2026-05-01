import { Router } from 'express';
import { memoryUpload } from '../middleware/upload.js';
import { ingestPdfToPinecone } from '../rag/ingest.js';
import { putKnowledgeObject } from '../lib/s3.js';
import { recordKnowledgeFile } from '../lib/knowledge-files.js';
import { HttpError } from '../middleware/error.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { uploadKnowledgeDailyLimiter } from '../middleware/rate-limit.js';
import { logger } from '../lib/logger.js';

export const uploadKnowledgeRouter: Router = Router();

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

      const organizationId = req.activeOrgId!;
      const rawDisplayName =
        typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
      const displayName = rawDisplayName || req.file.originalname;

      const { key, url } = await putKnowledgeObject(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        organizationId,
      );

      const message = await ingestPdfToPinecone({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        s3Key: key,
        s3Url: url,
        organizationId,
      });

      try {
        await recordKnowledgeFile({
          s3Key: key,
          organizationId,
          originalName: req.file.originalname,
          displayName,
          uploadedAt: new Date(),
          uploadedBy: req.user!.id,
          sizeBytes: req.file.size ?? 0,
        });
      } catch (err) {
        logger.warn({ err, key }, 'Failed to record knowledge file metadata (S3/Pinecone already committed)');
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
