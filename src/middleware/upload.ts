import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';

const UPLOAD_DIR = path.resolve('uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, file.originalname),
});

export const diskUpload = multer({
  storage: diskStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
