import { defineConfig } from 'vitest/config';

// Unit tests: no database, no network, no real .env. Fast; run by `npm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
