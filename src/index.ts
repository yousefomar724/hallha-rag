import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeMongo } from './lib/mongo.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'Hallha API listening');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close(async (err) => {
    if (err) logger.error({ err }, 'Error closing HTTP server');
    try {
      await closeMongo();
    } catch (closeErr) {
      logger.error({ err: closeErr }, 'Error closing MongoDB');
    }
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
