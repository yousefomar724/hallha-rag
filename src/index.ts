import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeMongo } from './lib/mongo.js';
import { cleanupOrphanCheckpoints, ensureChatHistoryIndexes } from './lib/chat-history.js';
import { ensureKnowledgeFileIndexes } from './lib/knowledge-files.js';
import { getEmbeddings } from './lib/embeddings.js';
import { recoverStalePendingIngests } from './lib/client-ingest.js';

const app = createApp();

void (async () => {
  try {
    await ensureChatHistoryIndexes();
    await ensureKnowledgeFileIndexes();
    await cleanupOrphanCheckpoints();
    await recoverStalePendingIngests();
  } catch (err) {
    logger.error({ err }, 'Chat history bootstrap failed (continuing)');
  }
})();

/**
 * Pre-warm the embedding pipeline. The Hugging Face transformer model
 * (Xenova/all-MiniLM-L6-v2, ~90 MB) is lazy-loaded on first call and adds
 * 30–60 s of latency on cold serverless containers. Eager loading at boot
 * eliminates the "tiny PDF upload returns 504" symptom seen in production.
 * If the warmup fails, we continue — first user request will retry the load.
 */
void (async () => {
  try {
    const started = Date.now();
    await getEmbeddings().embedQuery('warmup');
    logger.info({ ms: Date.now() - started }, 'Embedding pipeline warm');
  } catch (err) {
    logger.warn({ err }, 'Embedding pipeline warmup failed (continuing)');
  }
})();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'Hallha API listening');
});

// Raise Node's HTTP server timeouts so big uploads / slow ingest never get cut
// at the Node layer. Reverse proxies (nginx, Vercel, etc.) may impose their own
// limits — those need to be configured separately at the platform.
// Values are in ms. 300 s comfortably exceeds typical platform gateways (60–120s)
// without holding sockets forever.
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000 + 5_000;
server.keepAliveTimeout = 120_000;

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
