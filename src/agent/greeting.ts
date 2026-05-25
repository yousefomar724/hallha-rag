export type GreetingLanguage = 'ar' | 'en';

const ARABIC_REPLY =
  'وعليكم السلام ورحمة الله وبركاته 👋\n\nأنا هنا لمساعدتك في تدقيق الامتثال الشرعي. شارك معي مستندًا أو اطرح سؤالًا حول التمويل الإسلامي أو معايير AAOIFI لأبدأ.';

const ENGLISH_REPLY =
  "Wa alaikum assalam wa rahmatullahi wa barakatuh 👋\n\nI'm ready to help with Sharia compliance audits. Share a document or ask a question about Islamic finance or AAOIFI standards to get started.";

const ARABIC_GREETING_PATTERNS: RegExp[] = [
  /^(?:ال)?سلام\s*عل[يى]ك(?:م|ما)?(?:\s*ورحمة\s*الله(?:\s*وبركاته)?)?$/u,
  /^(?:مرحبا|مرحباً)$/u,
  /^أهل(?:ا|ًا|ا\s*وسهلا)?$/u,
  /^صباح\s*(?:الخير|النور)$/u,
  /^مساء\s*(?:الخير|النور)$/u,
];

const ENGLISH_GREETING_PATTERNS: RegExp[] = [
  /^(?:as|a)?salam(?:u)?(?:\s*[ou']?\s*alaikum)?(?:\s*wa?\s*rahmat(?:ullahi?)?(?:\s*wa?\s*barakatuh?)?)?$/i,
  /^salaam(?:\s*alaikum)?$/i,
  /^hi+$/i,
  /^hello+$/i,
  /^hey+$/i,
  /^howdy$/i,
  /^yo$/i,
  /^good\s*(?:morning|afternoon|evening|day)$/i,
  /^greetings$/i,
  /^marhaba$/i,
];

function normalize(input: string): string {
  return input
    .trim()
    .replace(/[!?.,؟،…\s]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function looksArabic(text: string): boolean {
  return /[؀-ۿ]/u.test(text);
}

export function detectGreeting(message: string | undefined): GreetingLanguage | null {
  if (!message) return null;
  const cleaned = normalize(message);
  if (!cleaned) return null;
  if (cleaned.length > 80) return null;

  if (looksArabic(cleaned)) {
    for (const re of ARABIC_GREETING_PATTERNS) {
      if (re.test(cleaned)) return 'ar';
    }
    return null;
  }

  for (const re of ENGLISH_GREETING_PATTERNS) {
    if (re.test(cleaned)) return 'en';
  }
  return null;
}

export function greetingReplyFor(lang: GreetingLanguage): string {
  return lang === 'ar' ? ARABIC_REPLY : ENGLISH_REPLY;
}

export type UserLanguage = 'ar' | 'en' | 'mixed';

const ARABIC_LETTER_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu;
const LATIN_LETTER_RE = /[A-Za-z]/g;

/**
 * Classify the dominant script of a user's message so the prompt can force a
 * matching response language. Returns 'en' when the message has no letters at
 * all (numbers / punctuation only) since the prompt default is English.
 */
export function detectUserLanguage(text: string | undefined | null): UserLanguage {
  if (!text) return 'en';
  const ar = text.match(ARABIC_LETTER_RE)?.length ?? 0;
  const lat = text.match(LATIN_LETTER_RE)?.length ?? 0;
  if (ar === 0 && lat === 0) return 'en';
  if (ar > 0 && lat === 0) return 'ar';
  if (lat > 0 && ar === 0) return 'en';
  const total = ar + lat;
  if (ar / total >= 0.85) return 'ar';
  if (lat / total >= 0.85) return 'en';
  return 'mixed';
}
