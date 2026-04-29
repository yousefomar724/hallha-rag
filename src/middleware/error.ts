import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { APIError } from 'better-auth';
import { IngestError } from '../rag/ingest.js';
import { logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function isQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('resource_exhausted') ||
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests')
  );
}

function isGroqUpstreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const n = err.name.toLowerCase();
  const msg = err.message;
  return (
    n.includes('groq') ||
    msg.includes('Groq API') ||
    msg.includes('api.groq.com')
  );
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

  if (isQuotaError(err)) {
    res.status(429).json({
      detail:
        'LLM rate limit or quota exceeded. Wait and retry, or check your Groq usage and plan limits ' +
        '(https://console.groq.com/docs/rate-limits).',
    });
    return;
  }

  if (isGroqUpstreamError(err)) {
    res.status(502).json({ detail: err instanceof Error ? err.message : String(err) });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const msg = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(500).json({ detail: msg });
};
