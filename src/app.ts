import express, { type Express } from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { uploadKnowledgeRouter } from './routes/upload-knowledge.js';
import { chatAuditRouter } from './routes/chat-audit.js';
import { errorHandler } from './middleware/error.js';

export function createApp(): Express {
  const app = express();

  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    }),
  );
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(uploadKnowledgeRouter);
  app.use(chatAuditRouter);

  app.use(errorHandler);

  return app;
}
