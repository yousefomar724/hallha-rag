import { z } from 'zod';

const envSchema = z.object({
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  PINECONE_API_KEY: z.string().min(1, 'PINECONE_API_KEY is required'),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  PORT: z.coerce.number().int().positive().default(8000),
  CORS_ORIGIN: z.string().default('*'),
  PINECONE_INDEX: z.string().default('hallha'),
  MONGO_DB_NAME: z.string().default('sharia_app'),
  MONGO_CHECKPOINT_COLLECTION: z.string().default('checkpoints_langgraph_js'),
  MONGO_CHECKPOINT_WRITES_COLLECTION: z.string().default('checkpoint_writes_langgraph_js'),

  LANGSMITH_TRACING: z.string().optional(),
  LANGSMITH_ENDPOINT: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
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
