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
      CORS_ORIGIN: 'http://127.0.0.1:3000',
      BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
      BETTER_AUTH_URL: 'http://127.0.0.1:8000',
      AUTH_TRUSTED_ORIGINS: 'http://127.0.0.1:3000',
      MONGO_ADAPTER_USE_TRANSACTIONS: 'false',
      SWAGGER_ENABLED: 'false',
    },
  },
});
