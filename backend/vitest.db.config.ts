import { defineConfig } from 'vitest/config';

// Database tests: real PostgreSQL (local throwaway instance, or hosted Supabase via DB_VERIFY_URL).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    globalSetup: ['tests/db/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
