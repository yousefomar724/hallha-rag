import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

import { getGuardrailLlm } from '../lib/llm.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_AUDIT_USER_MESSAGE } from './audit-defaults.js';

const guardrailSchema = z.object({
  related: z.boolean().describe(
    'True only if the user is asking about Sharia compliance, Islamic finance, halal investing, contractual or transactional auditing in that context, AAOIFI-style standards, riba/gharar/maysir, sukuk/murabaha and similar product questions, or requesting a Sharia audit of a document. False for greetings already handled elsewhere, jokes, cooking, general trivia, coding, politics, or any topic not tied to this assistant domain.',
  ),
});

const GUARDRAIL_SYSTEM = `You classify the latest user message for Halim, a Sharia compliance audit assistant.

Return related=true when the user is clearly engaging about: Sharia compliance, Islamic finance, auditing financial or legal documents for Sharia compliance, Islamic banking products, accounting standards like AAOIFI, or Islamic finance terminology.

Return related=false for chit-chat unrelated to that domain, jokes, recipes, general knowledge, programming, entertainment, or any request that is not about Islamic finance / Sharia auditing.

Respond only with the structured fields requested.`;

/** When the user only uploaded a file and sent the default audit prompt, skip the guardrail LLM. */
export function shouldSkipGuardrailLlm(documentText: string, lastUserText: string): boolean {
  return documentText.trim().length > 0 && lastUserText.trim() === DEFAULT_AUDIT_USER_MESSAGE;
}

export async function classifyRelatedToAudit(userMessage: string): Promise<boolean> {
  const trimmed = userMessage.trim();
  if (!trimmed) return true;

  const llm = getGuardrailLlm().withStructuredOutput(guardrailSchema);
  const result = await llm.invoke([
    new SystemMessage(GUARDRAIL_SYSTEM),
    new HumanMessage(trimmed),
  ]);

  try {
    const parsed = guardrailSchema.parse(result);
    return parsed.related;
  } catch (err) {
    logger.warn({ err }, 'Guardrail structured output parse failed; allowing request');
    return true;
  }
}
