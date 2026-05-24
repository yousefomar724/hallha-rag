import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { APIError } from 'better-auth';
import { IngestError } from '../rag/ingest.js';
import { logger } from '../lib/logger.js';
import { parseUpstreamLlmError } from '../lib/llm-errors.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.message });
    return;
  }

  if (err instanceof APIError) {
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
        ? err.statusCode
        : 400;
    const detail =
      err.body && typeof err.body === 'object' && err.body !== null && 'message' in err.body
        ? String((err.body as { message?: unknown }).message ?? err.message)
        : err.message;
    res.status(status).json({ detail });
    return;
  }

  if (err instanceof IngestError) {
    res.status(400).json({ detail: err.message });
    return;
  }

  const parsed = parseUpstreamLlmError(err);
  if (parsed.kind !== 'unknown') {
    if (parsed.retryAfterSeconds) {
      res.setHeader('Retry-After', String(parsed.retryAfterSeconds));
    }
    res.status(parsed.status).json({
      detail: parsed.message,
      kind: parsed.kind,
      ...(parsed.provider ? { provider: parsed.provider } : {}),
      ...(parsed.retryAfterSeconds ? { retryAfterSeconds: parsed.retryAfterSeconds } : {}),
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const msg = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(500).json({ detail: msg });
};
