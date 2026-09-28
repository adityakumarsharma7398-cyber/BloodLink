import { PrismaPg } from '@prisma/adapter-pg';
import type { AppConfig } from '../config/env.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { Logger } from '../lib/logger.js';

/**
 * Database access boundary.
 *
 * The backend connects as the database owner role, which BYPASSES row-level security. RLS therefore
 * protects only direct browser access and Realtime; for every backend query the authentication and
 * authorization layers (src/auth, src/authz) are the security boundary, and repositories must always
 * scope queries by the organization/facility resolved server-side.
 */
export type Tx = Prisma.TransactionClient;
export type DbClient = PrismaClient | Tx;

// Transactions handed out by withTransaction(). The audit service uses this to refuse writes that
// are not part of the caller's business transaction.
const transactionClients = new WeakSet<object>();
export const isTransactionClient = (client: unknown): client is Tx =>
  typeof client === 'object' && client !== null && transactionClients.has(client);

export interface TransactionOptions {
  timeoutMs?: number;
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export type ProbeResult = { ok: true; latencyMs: number } | { ok: false; reason: 'NOT_CONFIGURED' | 'TIMEOUT' | 'UNREACHABLE' };

export interface Database {
  readonly prisma: PrismaClient;
  readonly configured: boolean;
  withTransaction<T>(fn: (tx: Tx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** `select 1` with a hard timeout. Never throws and never returns error text. */
  probe(timeoutMs?: number): Promise<ProbeResult>;
  disconnect(): Promise<void>;
}

/** Supabase pooler: encrypted by default; `verify` additionally validates the server certificate. */
export function sslOption(ssl: AppConfig['database']['ssl']) {
  if (ssl.mode === 'disable') return false;
  if (ssl.mode === 'verify') return { rejectUnauthorized: true, ca: ssl.ca };
  return { rejectUnauthorized: false };
}

/** `pgbouncer=true` and friends are Prisma-engine hints that node-postgres does not understand. */
export function cleanConnectionString(url: string): string {
  const parsed = new URL(url);
  for (const param of ['pgbouncer', 'connection_limit', 'pool_timeout', 'schema']) parsed.searchParams.delete(param);
  return parsed.toString();
}

const DEFAULT_TX_TIMEOUT_MS = 15_000;
const DEFAULT_TX_MAX_WAIT_MS = 5_000;

export function createDatabase(config: AppConfig['database'], logger: Logger): Database {
  const url = config.url;
  // Lazy: with no URL the client is built so imports work, but every query fails as UNREACHABLE.
  const adapter = new PrismaPg({
    connectionString: url ? cleanConnectionString(url) : 'postgres://not-configured.invalid:5432/postgres',
    ssl: sslOption(config.ssl),
    max: config.poolMax,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const prisma = new PrismaClient({ adapter });

  return {
    prisma,
    configured: Boolean(url),

    withTransaction(fn, options = {}) {
      return prisma.$transaction(
        async (tx) => {
          transactionClients.add(tx);
          return fn(tx);
        },
        {
          timeout: options.timeoutMs ?? DEFAULT_TX_TIMEOUT_MS,
          maxWait: options.maxWaitMs ?? DEFAULT_TX_MAX_WAIT_MS,
          isolationLevel: options.isolationLevel,
        },
      );
    },

    async probe(timeoutMs = 3_000) {
      if (!url) return { ok: false, reason: 'NOT_CONFIGURED' };
      const startedAt = performance.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          prisma.$queryRaw`select 1`,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
          }),
        ]);
        return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
      } catch (error) {
        const timedOut = error instanceof Error && error.message === 'probe timeout';
        logger.warn('database probe failed', { reason: timedOut ? 'TIMEOUT' : 'UNREACHABLE', error });
        return { ok: false, reason: timedOut ? 'TIMEOUT' : 'UNREACHABLE' };
      } finally {
        clearTimeout(timer);
      }
    },

    async disconnect() {
      await prisma.$disconnect();
    },
  };
}
