import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import type { AiServiceClient } from './ai/aiServiceClient.js';

/** Dependency check result. `reason` is a fixed code, never raw error text (no internals leak). */
export interface DependencyStatus {
  readonly status: 'up' | 'down' | 'not_configured';
  readonly latencyMs?: number;
  readonly reason?: 'TIMEOUT' | 'UNREACHABLE' | 'ERROR_STATUS' | 'NOT_CONFIGURED';
}
export type Probe = () => Promise<DependencyStatus>;

export const databaseProbe =
  (db: Database): Probe =>
  async () => {
    const result = await db.probe();
    if (result.ok) return { status: 'up', latencyMs: result.latencyMs };
    return result.reason === 'NOT_CONFIGURED'
      ? { status: 'not_configured', reason: 'NOT_CONFIGURED' }
      : { status: 'down', reason: result.reason };
  };

export const aiServiceProbe =
  (client: AiServiceClient): Probe =>
  async () => {
    const startedAt = performance.now();
    try {
      await client.call('/health', { timeoutMs: 3_000 });
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch {
      return { status: 'down', reason: 'UNREACHABLE' };
    }
  };

/** Supabase Auth's public health endpoint (publishable key only). */
export const supabaseProbe =
  (config: AppConfig['supabase']): Probe =>
  async () => {
    if (!config.url || !config.anonKey) return { status: 'not_configured', reason: 'NOT_CONFIGURED' };
    const startedAt = performance.now();
    try {
      const response = await fetch(new URL('/auth/v1/health', config.url), {
        headers: { apikey: config.anonKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { status: 'down', reason: 'ERROR_STATUS' };
      return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
    } catch (error) {
      return { status: 'down', reason: error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE' };
    }
  };
