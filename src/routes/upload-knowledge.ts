import { Router } from 'express';
import { memoryUpload } from '../middleware/upload.js';
import { ingestPdfToPinecone } from '../rag/ingest.js';
import { putKnowledgeObject } from '../lib/s3.js';
import { HttpError } from '../middleware/error.js';
import { requireAdmin } from '../middleware/require-admin.js';
import { uploadKnowledgeDailyLimiter } from '../middleware/rate-limit.js';

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

      res.json({
        status: 'success',
        message,
        source: { name: req.file.originalname, key, url },
      });
    } catch (err) {
      next(err);
    }
  },
);
