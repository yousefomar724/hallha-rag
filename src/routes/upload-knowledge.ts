import { Router } from 'express';
import { diskUpload } from '../middleware/upload.js';
import { ingestPdfToPinecone } from '../rag/ingest.js';
import { HttpError } from '../middleware/error.js';

export const uploadKnowledgeRouter: Router = Router();

uploadKnowledgeRouter.post('/upload-knowledge', diskUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new HttpError(400, 'Missing required field "file".');
    }
    const message = await ingestPdfToPinecone(req.file.path);
    res.json({ status: 'success', message });
  } catch (err) {
    next(err);
  }
});
