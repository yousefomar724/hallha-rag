import { describe, it, expect } from 'vitest';
import { parseUpstreamLlmError } from '../src/lib/llm-errors.js';

describe('parseUpstreamLlmError', () => {
  it('detects DeepSeek quota exhaustion', () => {
    const err = new Error(
      '429 You exceeded your current quota, code: insufficient_quota, api.deepseek.com',
    );
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('quota_exhausted');
    expect(parsed.status).toBe(429);
    expect(parsed.provider).toBe('deepseek');
  });

  it('detects DeepSeek rate limiting', () => {
    const err = new Error(
      '429 Too Many Requests on api.deepseek.com, code: rate_limit_exceeded',
    );
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('rate_limited');
    expect(parsed.status).toBe(429);
    expect(parsed.provider).toBe('deepseek');
  });

  it('extracts retry-after seconds from DeepSeek errors', () => {
    const err = new Error('429 retry-after: 30, api.deepseek.com');
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.retryAfterSeconds).toBe(30);
    expect(parsed.provider).toBe('deepseek');
  });

  it('detects DeepSeek invalid API key', () => {
    const err = new Error('401 invalid api key, api.deepseek.com');
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('invalid_api_key');
    expect(parsed.status).toBe(502);
    expect(parsed.provider).toBe('deepseek');
  });

  it('detects OpenRouter quota exhaustion', () => {
    const err = new Error(
      '429 You exceeded your current quota, code: insufficient_quota, openrouter.ai',
    );
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('quota_exhausted');
    expect(parsed.status).toBe(429);
    expect(parsed.provider).toBe('openrouter');
  });

  it('detects OpenRouter rate limiting', () => {
    const err = new Error(
      '429 Too Many Requests on openrouter.ai/api/v1, code: rate_limit_exceeded',
    );
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('rate_limited');
    expect(parsed.status).toBe(429);
    expect(parsed.provider).toBe('openrouter');
  });

  it('detects OpenRouter invalid API key', () => {
    const err = new Error('401 invalid api key, openrouter.ai');
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('invalid_api_key');
    expect(parsed.status).toBe(502);
    expect(parsed.provider).toBe('openrouter');
  });

  it('detects Gemini RESOURCE_EXHAUSTED as quota', () => {
    const err = new Error(
      'GoogleGenerativeAI Error: RESOURCE_EXHAUSTED — quota exceeded for generativelanguage.googleapis.com',
    );
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('quota_exhausted');
    expect(parsed.status).toBe(429);
    expect(parsed.provider).toBe('gemini');
  });

  it('detects Groq rate limiting', () => {
    const err = new Error('429 rate_limit_exceeded at api.groq.com');
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('rate_limited');
    expect(parsed.status).toBe(429);
    expect(parsed.provider).toBe('groq');
  });

  it('returns unknown for unrecognized errors', () => {
    const err = new Error('Something completely unrelated');
    const parsed = parseUpstreamLlmError(err);
    expect(parsed.kind).toBe('unknown');
    expect(parsed.status).toBe(500);
  });
});
