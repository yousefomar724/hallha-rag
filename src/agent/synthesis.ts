import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

import { getLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

const SYNTHESIS_SYSTEM = `You are drafting system context for a Sharia compliance AI assistant named Halim.

TASK
Based on the user's structured onboarding answers (provided as JSON in the next message):
- Produce ONE concise paragraph (maximum 120 words).
- Focus on operational context, payment/revenue mechanics where relevant (business path), or standards and specialization (auditor path).
- Note industry-level Sharia-sensitive themes (riba, gharar, speculative instruments, prohibited sectors) only when grounded in what they shared.
- Do NOT invent facts. Use neutral, professional wording.

OUTPUT
Return ONLY the paragraph. No headings, bullets, or quotes wrapping the whole answer.`;

export async function generateContextSummary(input: {
  userType: 'business' | 'auditor';
  onboardingData: Record<string, unknown>;
  legalName?: string;
}): Promise<string> {
  try {
    const payload = JSON.stringify({
      userType: input.userType,
      ...(input.legalName?.trim() ? { legalName: input.legalName.trim() } : {}),
      ...input.onboardingData,
    });
    const llm = getLlm();
    const response = await llm.invoke([
      new SystemMessage(SYNTHESIS_SYSTEM),
      new HumanMessage(`Structured onboarding data (JSON):\n${payload}`),
    ]);

    const raw = AIMessage.isInstance(response) ? response.content : response;
    const text = messageContentToText(raw).trim();

    if (!text.length) return '';
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= 120) return text;
    return `${words.slice(0, 120).join(' ')}…`;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'generateContextSummary failed; proceeding without summary',
    );
    return '';
  }
}
