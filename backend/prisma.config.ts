import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Same root-level .env as the rest of the backend.
dotenv.config({ path: path.resolve(import.meta.dirname, '../.env'), quiet: true });

/**
 * Prisma is a typed READ/WRITE CLIENT ONLY (decision B). The database schema is owned by the
 * Supabase SQL migrations in /supabase/migrations: never run `prisma migrate` or `prisma db push`.
 * `prisma db pull` introspects DIRECT_URL (session pooler / direct connection).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  // Only `prisma db pull` needs a connection; `prisma generate` must also work without credentials.
  datasource: {
    url: process.env.DIRECT_URL ?? '',
  },
});
