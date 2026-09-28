import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, inject } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../../supabase/migrations');
export const SHIM_SQL = readFileSync(path.join(here, 'supabase-shim.sql'), 'utf8');

/** Migration files in apply order. pg_cron is unavailable locally, so its migration is applied only on hosted Supabase. */
export function migrationFiles({ includeScheduledJobs }: { includeScheduledJobs: boolean }) {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => includeScheduledJobs || !file.includes('scheduled_jobs'))
    .sort();
}

export async function applyMigrations(client: pg.Client, options: { includeScheduledJobs: boolean }) {
  for (const file of migrationFiles(options)) {
    await client.query(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

export const isHosted = () => inject('dbTarget') === 'hosted';

export async function connect(database?: string) {
  const url = new URL(inject('dbUrl'));
  if (database) url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** Runs `fn` inside a transaction that is always rolled back, so tests leave no data behind. */
export async function inRollback<T>(client: pg.Client, fn: () => Promise<T>) {
  await client.query('begin');
  try {
    return await fn();
  } finally {
    await client.query('rollback');
  }
}

/** Executes SQL expected to fail; keeps the surrounding transaction usable via a savepoint. */
export async function expectDbError(client: pg.Client, sql: string, params: unknown[], pattern: RegExp) {
  await client.query('savepoint expect_error');
  let error: unknown;
  try {
    await client.query(sql, params);
  } catch (caught) {
    error = caught;
  }
  await client.query('rollback to savepoint expect_error');
  expect(error, `expected failure for: ${sql}`).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

/** Switches the current transaction to a signed-in browser user (role `authenticated`). */
export async function actAs(client: pg.Client, userId: string | null) {
  if (userId === null) {
    await client.query('set local role anon');
    await client.query(`select set_config('request.jwt.claim.sub', '', true)`);
    return;
  }
  await client.query('set local role authenticated');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
}

export async function actAsBackend(client: pg.Client) {
  await client.query('reset role');
  await client.query(`select set_config('request.jwt.claim.sub', '', true)`);
}

export async function one<T = Record<string, unknown>>(client: pg.Client, sql: string, params: unknown[] = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] as T;
}

export async function scalar<T = unknown>(client: pg.Client, sql: string, params: unknown[] = []) {
  const { rows } = await client.query(sql, params);
  return (rows[0] ? Object.values(rows[0])[0] : undefined) as T;
}
