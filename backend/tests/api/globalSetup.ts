import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    apiDbUrl: string;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../supabase/migrations');
const PORT = 54339;
let server: EmbeddedPostgres | undefined;

/**
 * API tests ALWAYS run against a throwaway local PostgreSQL 17 with the approved migrations.
 * They never read DB_VERIFY_URL, DATABASE_URL, DIRECT_URL or the developer's `.env`, and can
 * never reach hosted Supabase.
 */
export async function setup(project: TestProject) {
  server = new EmbeddedPostgres({
    databaseDir: path.resolve(here, '../../.pgtest/api'),
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('bloodlink_api');

  const url = `postgres://postgres:postgres@localhost:${PORT}/bloodlink_api`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(readFileSync(path.resolve(here, '../db/supabase-shim.sql'), 'utf8'));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && !f.includes('scheduled_jobs')).sort()) {
    await client.query(readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
  await client.end();

  project.provide('apiDbUrl', url);
}

export async function teardown() {
  await server?.stop();
}
