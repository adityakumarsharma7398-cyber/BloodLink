import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Configuration is split in two on purpose:
 *
 *  - `parseConfig(source)` is PURE: it validates an explicit key/value object. Tests call it with
 *    fixtures and never touch the developer's `.env`.
 *  - `loadRuntimeConfig()` is the ONLY place that reads `.env` / `process.env`, and it skips
 *    `.env` entirely under test (NODE_ENV=test / VITEST).
 *
 * Error messages name variables, never values, so a failed start cannot leak a secret.
 */

export class ConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const trustProxy = z
  .string()
  .trim()
  .default('false')
  .transform((value, ctx): number | false => {
    if (value === 'false' || value === '0') return false;
    const hops = Number(value);
    if (Number.isInteger(hops) && hops > 0 && hops <= 10) return hops;
    ctx.addIssue({ code: 'custom', message: 'must be "false" or a hop count between 1 and 10 (never "true")' });
    return z.NEVER;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: trustProxy,
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  SUPABASE_URL: optionalString.pipe(z.url().optional()),
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  DATABASE_URL: optionalString,
  DIRECT_URL: optionalString,
  DATABASE_SSL: z.enum(['disable', 'require', 'verify']).default('require'),
  DATABASE_SSL_CA: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  AI_SERVICE_URL: z.url().default('http://localhost:8000'),
  AI_SERVICE_API_KEY: optionalString,

  MAPS_PROVIDER: z.enum(['mock', 'google']).default('mock'),
  GOOGLE_MAPS_SERVER_KEY: optionalString,
  NOTIFICATION_PROVIDER: z.enum(['inapp', 'fcm']).default('inapp'),
  FCM_PROJECT_ID: optionalString,
  FCM_CLIENT_EMAIL: optionalString,
  FCM_PRIVATE_KEY: optionalString,
  ERAKTKOSH_MODE: z.enum(['mock', 'live']).default('mock'),
  ERAKTKOSH_API_BASE_URL: optionalString,
  ERAKTKOSH_API_KEY: optionalString,

  // Development/testing only; refused in production (compatibility_rules stay DEMO_ONLY until validated).
  ALLOW_DEMO_COMPATIBILITY_RULES: booleanFlag,

  RATE_LIMIT_PUBLIC_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  RATE_LIMIT_AUTH_FAILURES_PER_15_MIN: z.coerce.number().int().min(1).max(100_000).default(100),
});

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly trustProxy: number | false;
  readonly requestTimeoutMs: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  readonly supabase: { readonly url?: string; readonly anonKey?: string; readonly serviceRoleKey?: string };
  readonly database: {
    readonly url?: string;
    readonly directUrl?: string;
    readonly ssl: { readonly mode: 'disable' | 'require' | 'verify'; readonly ca?: string };
    readonly poolMax: number;
  };
  readonly ai: { readonly url: string; readonly apiKey?: string };
  readonly adapters: {
    readonly maps: { readonly provider: 'mock' | 'google'; readonly googleServerKey?: string };
    readonly notifications: {
      readonly provider: 'inapp' | 'fcm';
      readonly fcm?: { readonly projectId: string; readonly clientEmail: string; readonly privateKey: string };
    };
    readonly eraktkosh: { readonly mode: 'mock' | 'live'; readonly baseUrl?: string; readonly apiKey?: string };
  };
  readonly compatibility: { readonly allowDemoRules: boolean };
  readonly rateLimit: { readonly publicPerMinute: number; readonly authFailuresPer15Min: number };
}

export function parseConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
  }
  const e = result.data;
  const production = e.NODE_ENV === 'production';
  const issues: string[] = [];
  const need = (name: string, value: unknown, reason: string) => {
    if (!value) issues.push(`${name} is required ${reason}`);
  };

  if (production && e.ALLOW_DEMO_COMPATIBILITY_RULES) {
    issues.push('ALLOW_DEMO_COMPATIBILITY_RULES must not be "true" in production (demo compatibility rules are not clinically validated)');
  }
  if (production) {
    need('SUPABASE_URL', e.SUPABASE_URL, 'in production');
    need('SUPABASE_ANON_KEY', e.SUPABASE_ANON_KEY, 'in production (token verification)');
    need('DATABASE_URL', e.DATABASE_URL, 'in production');
    need('AI_SERVICE_API_KEY', e.AI_SERVICE_API_KEY, 'in production');
    if (e.DATABASE_SSL === 'disable') issues.push('DATABASE_SSL must not be "disable" in production');
  }
  const origins = e.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (production && origins.some((origin) => origin === '*')) issues.push('CORS_ORIGINS must list explicit origins in production (no "*")');
  if (e.DATABASE_SSL === 'verify') need('DATABASE_SSL_CA', e.DATABASE_SSL_CA, 'when DATABASE_SSL=verify');

  // Optional integrations stay optional unless their provider is switched on.
  if (e.MAPS_PROVIDER === 'google') need('GOOGLE_MAPS_SERVER_KEY', e.GOOGLE_MAPS_SERVER_KEY, 'when MAPS_PROVIDER=google');
  if (e.NOTIFICATION_PROVIDER === 'fcm') {
    need('FCM_PROJECT_ID', e.FCM_PROJECT_ID, 'when NOTIFICATION_PROVIDER=fcm');
    need('FCM_CLIENT_EMAIL', e.FCM_CLIENT_EMAIL, 'when NOTIFICATION_PROVIDER=fcm');
    need('FCM_PRIVATE_KEY', e.FCM_PRIVATE_KEY, 'when NOTIFICATION_PROVIDER=fcm');
  }
  if (e.ERAKTKOSH_MODE === 'live') {
    need('ERAKTKOSH_API_BASE_URL', e.ERAKTKOSH_API_BASE_URL, 'when ERAKTKOSH_MODE=live');
    need('ERAKTKOSH_API_KEY', e.ERAKTKOSH_API_KEY, 'when ERAKTKOSH_MODE=live');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    isProduction: production,
    port: e.BACKEND_PORT,
    corsOrigins: origins,
    trustProxy: e.TRUST_PROXY,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    logLevel: e.LOG_LEVEL,
    supabase: { url: e.SUPABASE_URL, anonKey: e.SUPABASE_ANON_KEY, serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY },
    database: {
      url: e.DATABASE_URL,
      directUrl: e.DIRECT_URL,
      ssl: { mode: e.DATABASE_SSL, ca: e.DATABASE_SSL_CA },
      poolMax: e.DATABASE_POOL_MAX,
    },
    ai: { url: e.AI_SERVICE_URL, apiKey: e.AI_SERVICE_API_KEY },
    adapters: {
      maps: { provider: e.MAPS_PROVIDER, googleServerKey: e.GOOGLE_MAPS_SERVER_KEY },
      notifications: {
        provider: e.NOTIFICATION_PROVIDER,
        fcm:
          e.NOTIFICATION_PROVIDER === 'fcm'
            ? { projectId: e.FCM_PROJECT_ID!, clientEmail: e.FCM_CLIENT_EMAIL!, privateKey: e.FCM_PRIVATE_KEY! }
            : undefined,
      },
      eraktkosh: { mode: e.ERAKTKOSH_MODE, baseUrl: e.ERAKTKOSH_API_BASE_URL, apiKey: e.ERAKTKOSH_API_KEY },
    },
    compatibility: { allowDemoRules: e.ALLOW_DEMO_COMPATIBILITY_RULES },
    rateLimit: {
      publicPerMinute: e.RATE_LIMIT_PUBLIC_PER_MINUTE,
      authFailuresPer15Min: e.RATE_LIMIT_AUTH_FAILURES_PER_15_MIN,
    },
  };
}

/** Which capabilities are configured — booleans only, safe to log. */
export function describeConfig(config: AppConfig) {
  return {
    env: config.env,
    port: config.port,
    databaseConfigured: Boolean(config.database.url),
    databaseSsl: config.database.ssl.mode,
    supabaseVerifierConfigured: Boolean(config.supabase.url && config.supabase.anonKey),
    aiServiceKeyConfigured: Boolean(config.ai.apiKey),
    maps: config.adapters.maps.provider,
    notifications: config.adapters.notifications.provider,
    eraktkosh: config.adapters.eraktkosh.mode,
    demoCompatibilityRules: config.compatibility.allowDemoRules,
  };
}

const rootEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env');

/** Server entry point only. Under test the developer's real `.env` is never read. */
export function loadRuntimeConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const isTest = source.NODE_ENV === 'test' || Boolean(source.VITEST);
  if (!isTest) dotenv.config({ path: rootEnvPath, quiet: true });
  return parseConfig(source === process.env ? process.env : source);
}
