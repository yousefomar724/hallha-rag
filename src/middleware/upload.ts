import multer from 'multer';

/**
 * Zero disk persistence for user uploads: buffers stay in RAM only and are released after the handler
 * completes; do not switch to diskStorage for audit uploads.
 */
export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/** Voice clips for Groq Whisper (small multipart payloads). Same in-memory contract. */
export const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
