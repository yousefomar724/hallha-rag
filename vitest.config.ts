import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      GROQ_API_KEY: 'test-groq-key',
      PINECONE_API_KEY: 'test-pinecone-key',
      MONGO_URI: 'mongodb://localhost:27017/test',
      PORT: '8000',
      CORS_ORIGIN: '*',
    },
  },
});
