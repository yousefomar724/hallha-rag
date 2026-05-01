import { z } from 'zod';

const envSchema = z.object({
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  /** Small/fast model for intent guardrail before RAG (Groq). */
  GROQ_GUARDRAIL_MODEL: z.string().default('llama-3.1-8b-instant'),
  GROQ_TRANSCRIPTION_MODEL: z.string().default('whisper-large-v3-turbo'),
  PINECONE_API_KEY: z.string().min(1, 'PINECONE_API_KEY is required'),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  PORT: z.coerce.number().int().positive().default(8000),
  CORS_ORIGIN: z.string().default('*'),
  PINECONE_INDEX: z.string().default('hallha'),
  MONGO_DB_NAME: z.string().default('sharia_app'),
  MONGO_CHECKPOINT_COLLECTION: z.string().default('checkpoints_langgraph_js'),
  MONGO_CHECKPOINT_WRITES_COLLECTION: z.string().default('checkpoint_writes_langgraph_js'),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a valid URL'),
  AUTH_TRUSTED_ORIGINS: z.string().default(''),
  COOKIE_DOMAIN: z.string().optional(),

  /** When true, Better Auth uses multi-document transactions (requires replica set). Default false for local dev / standalone MongoDB. */
  MONGO_ADAPTER_USE_TRANSACTIONS: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),

  /** Expose `/docs` (Swagger UI) and `/openapi.json`. Set to false to disable in production. */
  SWAGGER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),

  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),

  AWS_REGION: z.string().min(1, 'AWS_REGION is required'),
  AWS_S3_BUCKET_NAME: z.string().min(1, 'AWS_S3_BUCKET_NAME is required'),
  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required'),
  AWS_S3_BUCKET_URL: z.string().optional(),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /** Tavily web search for Halim agent tool-calling */
  TAVILY_API_KEY: z.string().min(1, 'TAVILY_API_KEY is required'),

  ADMIN_ORIGIN: z.string().default('http://localhost:5173'),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
