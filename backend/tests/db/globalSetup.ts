import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { applyMigrations, SHIM_SQL } from './harness.js';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string;
    dbTarget: 'local' | 'hosted';
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 54329;
let server: EmbeddedPostgres | undefined;

/**
 * Local mode (default): starts a throwaway PostgreSQL 17, creates `bloodlink_test`, applies the
 * Supabase shim + migrations. Hosted mode: DB_VERIFY_URL points at the hosted project, where the
 * migrations have already been applied with the Supabase CLI; tests then only read the catalog or
 * run inside transactions that are rolled back.
 */
export async function setup(project: TestProject) {
  if (process.env.DB_VERIFY_URL) {
    project.provide('dbUrl', process.env.DB_VERIFY_URL);
    project.provide('dbTarget', 'hosted');
    return;
  }

  server = new EmbeddedPostgres({
    databaseDir: path.resolve(here, '../../.pgtest/data'),
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('bloodlink_test');

  const url = `postgres://postgres:postgres@localhost:${PORT}/bloodlink_test`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(SHIM_SQL);
  await applyMigrations(client, { includeScheduledJobs: false });
  await client.end();

  project.provide('dbUrl', url);
  project.provide('dbTarget', 'local');
}

export async function teardown() {
  await server?.stop();
}
