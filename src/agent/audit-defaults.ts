/** Shown when the client sends a file but no message body. Must match chat-audit route. */
export const DEFAULT_AUDIT_USER_MESSAGE = 'Please audit the attached document.';

/** Off-topic refusal when the user's message is not mainly in Arabic script. */
export const GUARDRAIL_REFUSAL_MESSAGE_EN =
  'I am Halim, your Sharia Audit assistant. I specialize in Islamic finance and cannot assist with that topic.';

/** Off-topic refusal when the user's message includes Arabic script (same meaning as EN). */
export const GUARDRAIL_REFUSAL_MESSAGE_AR =
  'أنا حليم مساعدك في التدقيق الشرعي. أتخصص في التمويل الإسلامي ولا يمكنني المساعدة في هذا الموضوع.';

/** Same Arabic-script detection as `greeting.ts` (`detectGreeting`). */
function lastUserTextLooksArabic(lastUserText: string): boolean {
  return /[؀-ۿ]/u.test(lastUserText.trim());
}

/** Picks EN vs AR refusal from the latest user message language (Arabic script → AR). */
export function guardrailRefusalMessageForUserText(lastUserText: string): string {
  return lastUserTextLooksArabic(lastUserText)
    ? GUARDRAIL_REFUSAL_MESSAGE_AR
    : GUARDRAIL_REFUSAL_MESSAGE_EN;
}
