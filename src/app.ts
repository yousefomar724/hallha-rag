import express, { type Express } from 'express';
import cors, { type CorsOptions } from 'cors';
import { pinoHttp } from 'pino-http';
import { toNodeHandler } from 'better-auth/node';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { auth } from './lib/auth.js';
import { uploadKnowledgeRouter } from './routes/upload-knowledge.js';
import { chatAuditRouter } from './routes/chat-audit.js';
import { chatsRouter } from './routes/chats.js';
import { organizationsRouter } from './routes/organizations.js';
import { errorHandler } from './middleware/error.js';
import { installSwagger } from './openapi/install-swagger.js';

function buildCorsOrigin(): CorsOptions['origin'] {
  const trusted = env.AUTH_TRUSTED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const explicit =
    env.CORS_ORIGIN === '*'
      ? []
      : env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  const allowed = [...new Set([...trusted, ...explicit])];

  return (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowed.includes(origin)) {
      callback(null, true);
      return;
    }
    if (env.CORS_ORIGIN === '*' && (env.NODE_ENV === 'development' || env.NODE_ENV === 'test')) {
      callback(null, origin);
      return;
    }
    if (env.CORS_ORIGIN === '*' && trusted.length === 0) {
      logger.warn(
        'CORS_ORIGIN is * but credentials are enabled; set AUTH_TRUSTED_ORIGINS to explicit frontend URLs.',
      );
    }
    callback(null, false);
  };
}

export function createApp(): Express {
  const app = express();

  const authHandler = toNodeHandler(auth);
  app.all('/api/auth/*splat', (req, res, next) => {
    void authHandler(req, res).catch(next);
  });

  app.use(
    cors({
      origin: buildCorsOrigin(),
      credentials: true,
    }),
  );
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (env.SWAGGER_ENABLED) {
    const docBase = env.BETTER_AUTH_URL.replace(/\/$/, '');
    installSwagger(app, docBase);
  }

  app.use(uploadKnowledgeRouter);
  app.use(chatAuditRouter);
  app.use(chatsRouter);
  app.use(organizationsRouter);

  app.use(errorHandler);

  return app;
}
