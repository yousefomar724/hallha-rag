import Groq, { toFile } from 'groq-sdk';
import { env } from '../config/env.js';

let client: Groq | null = null;

function getGroqClient(): Groq {
  if (!client) {
    client = new Groq({ apiKey: env.GROQ_API_KEY });
  }
  return client;
}

export async function transcribeAudioBuffer(buffer: Buffer, filename: string): Promise<string> {
  const groq = getGroqClient();
  const file = await toFile(buffer, filename);
  const result = await groq.audio.transcriptions.create({
    file,
    model: env.GROQ_TRANSCRIPTION_MODEL,
  });
  return typeof result.text === 'string' ? result.text : '';
}
