import type { Request, Response } from 'express';
import { rateLimit, ipKeyGenerator, type Options } from 'express-rate-limit';

function userOrIpKey(prefix: string) {
  return (req: Request, _res: Response): string => {
    if (req.user?.id) return `${prefix}:u:${req.user.id}`;
    const ip = req.ip ?? '';
    return `${prefix}:ip:${ipKeyGenerator(ip)}`;
  };
}

function rateLimitHandler(message: string): Options['handler'] {
  return (_req, res, _next, _options) => {
    res.status(429).json({ detail: message });
  };
}

const baseOptions = {
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
};

export const chatAuditMinuteLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: userOrIpKey('chat-audit-1m'),
  handler: rateLimitHandler(
    'You are sending requests too quickly. Please wait a minute and try again.',
  ),
});

export const chatAuditHourlyLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60_000,
  limit: 200,
  keyGenerator: userOrIpKey('chat-audit-1h'),
  handler: rateLimitHandler(
    'Hourly request limit reached. Please wait a while before trying again.',
  ),
});

export const transcribeMinuteLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit: 40,
  keyGenerator: userOrIpKey('chat-transcribe-1m'),
  handler: rateLimitHandler(
    'Too many transcription requests. Please wait a minute and try again.',
  ),
});

export const transcribeHourlyLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60_000,
  limit: 400,
  keyGenerator: userOrIpKey('chat-transcribe-1h'),
  handler: rateLimitHandler(
    'Hourly transcription limit reached. Please wait before recording again.',
  ),
});

export const uploadKnowledgeMinuteLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60_000,
  limit: 5,
  keyGenerator: userOrIpKey('upload-knowledge-1m'),
  handler: rateLimitHandler(
    'You are uploading knowledge files too quickly. Please wait a minute and try again.',
  ),
});

export const uploadKnowledgeDailyLimiter = rateLimit({
  ...baseOptions,
  windowMs: 24 * 60 * 60_000,
  limit: 30,
  keyGenerator: userOrIpKey('upload-knowledge-1d'),
  handler: rateLimitHandler(
    'Daily knowledge-upload limit reached. Please try again tomorrow.',
  ),
});
