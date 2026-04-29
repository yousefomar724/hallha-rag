import { ChatGroq } from '@langchain/groq';
import { env } from '../config/env.js';

let singleton: ChatGroq | null = null;

export function getLlm(): ChatGroq {
  if (!singleton) {
    singleton = new ChatGroq({
      apiKey: env.GROQ_API_KEY,
      model: env.GROQ_MODEL,
      temperature: 0,
    });
  }
  return singleton;
}
