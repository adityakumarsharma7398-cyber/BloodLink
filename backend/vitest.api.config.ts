import { defineConfig } from 'vitest/config';

// API integration tests: the real Express app + Prisma against a throwaway LOCAL PostgreSQL 17
// (approved migrations applied). Never connects to hosted Supabase and never reads `.env`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/api/**/*.test.ts'],
    globalSetup: ['tests/api/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
