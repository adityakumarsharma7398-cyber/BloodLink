import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

import dotenv from 'dotenv';
import { ConfigError, describeConfig, loadRuntimeConfig, parseConfig } from '../../src/config/env.js';

const SECRET = 'zz-secret-9f3a-do-not-print';

const validProduction = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_example',
  DATABASE_URL: 'postgres://user:pw@db.example:6543/postgres',
  AI_SERVICE_API_KEY: 'a-long-random-shared-key',
  CORS_ORIGINS: 'https://app.example.com',
};

const issuesOf = (source: Record<string, string>) => {
  try {
    parseConfig(source);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
};

afterEach(() => vi.clearAllMocks());

describe('parseConfig', () => {
  it('applies safe development defaults from an empty source', () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      env: 'development', port: 4000, trustProxy: false, requestTimeoutMs: 30_000, logLevel: 'info',
      compatibility: { allowDemoRules: false }, rateLimit: { publicPerMinute: 120, authFailuresPer15Min: 100 },
      database: { ssl: { mode: 'require' }, poolMax: 10 },
      adapters: { maps: { provider: 'mock' }, notifications: { provider: 'inapp' }, eraktkosh: { mode: 'mock' } },
    });
    expect(config.corsOrigins).toEqual(['http://localhost:5173']);
  });

  it('reports invalid values by variable name only, never the value', () => {
    const issues = issuesOf({ BACKEND_PORT: SECRET, SUPABASE_URL: SECRET, LOG_LEVEL: SECRET });
    expect(issues.join('\n')).toMatch(/BACKEND_PORT/);
    expect(issues.join('\n')).toMatch(/SUPABASE_URL/);
    expect(issues.join('\n')).toMatch(/LOG_LEVEL/);
    expect(issues.join('\n')).not.toContain(SECRET);
    try {
      parseConfig({ SUPABASE_URL: SECRET });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
  });

  it('accepts a complete production configuration', () => {
    const config = parseConfig(validProduction);
    expect(config.isProduction).toBe(true);
    expect(config.corsOrigins).toEqual(['https://app.example.com']);
  });

  it('requires the core settings in production', () => {
    const issues = issuesOf({ NODE_ENV: 'production' }).join('\n');
    for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'DATABASE_URL', 'AI_SERVICE_API_KEY']) expect(issues).toContain(name);
  });

  it('does not require them in development or test', () => {
    expect(issuesOf({ NODE_ENV: 'development' })).toEqual([]);
    expect(issuesOf({ NODE_ENV: 'test' })).toEqual([]);
  });

  it('refuses ALLOW_DEMO_COMPATIBILITY_RULES=true in production only', () => {
    expect(issuesOf({ ...validProduction, ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }).join('\n')).toContain('ALLOW_DEMO_COMPATIBILITY_RULES');
    expect(parseConfig({ ...validProduction, ALLOW_DEMO_COMPATIBILITY_RULES: 'false' }).compatibility.allowDemoRules).toBe(false);
    expect(parseConfig({ NODE_ENV: 'development', ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }).compatibility.allowDemoRules).toBe(true);
    expect(parseConfig({ NODE_ENV: 'test', ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }).compatibility.allowDemoRules).toBe(true);
  });

  it('rejects unsafe production transport and CORS settings', () => {
    expect(issuesOf({ ...validProduction, DATABASE_SSL: 'disable' }).join('\n')).toContain('DATABASE_SSL');
    expect(issuesOf({ ...validProduction, CORS_ORIGINS: '*' }).join('\n')).toContain('CORS_ORIGINS');
  });

  it('keeps optional integrations optional until their provider is switched on', () => {
    expect(issuesOf({ MAPS_PROVIDER: 'mock', NOTIFICATION_PROVIDER: 'inapp', ERAKTKOSH_MODE: 'mock' })).toEqual([]);
    expect(issuesOf({ MAPS_PROVIDER: 'google' }).join('\n')).toContain('GOOGLE_MAPS_SERVER_KEY');
    const fcm = issuesOf({ NOTIFICATION_PROVIDER: 'fcm' }).join('\n');
    for (const name of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) expect(fcm).toContain(name);
    const live = issuesOf({ ERAKTKOSH_MODE: 'live' }).join('\n');
    for (const name of ['ERAKTKOSH_API_BASE_URL', 'ERAKTKOSH_API_KEY']) expect(live).toContain(name);
    expect(parseConfig({ MAPS_PROVIDER: 'google', GOOGLE_MAPS_SERVER_KEY: 'k' }).adapters.maps.googleServerKey).toBe('k');
  });

  it('parses TRUST_PROXY as a hop count and never as "true"', () => {
    expect(parseConfig({}).trustProxy).toBe(false);
    expect(parseConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(issuesOf({ TRUST_PROXY: 'true' }).join('\n')).toContain('TRUST_PROXY');
  });

  it('requires a CA when server certificates are verified', () => {
    expect(issuesOf({ DATABASE_SSL: 'verify' }).join('\n')).toContain('DATABASE_SSL_CA');
    expect(parseConfig({ DATABASE_SSL: 'verify', DATABASE_SSL_CA: 'pem' }).database.ssl).toEqual({ mode: 'verify', ca: 'pem' });
  });

  it('describeConfig reports capabilities as booleans and never includes a secret', () => {
    const summary = JSON.stringify(describeConfig(parseConfig({ ...validProduction, SUPABASE_SERVICE_ROLE_KEY: SECRET })));
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toContain('pw@');
    expect(summary).not.toContain('a-long-random-shared-key');
  });
});

describe('loadRuntimeConfig', () => {
  it('never reads the .env file under test', () => {
    loadRuntimeConfig({ NODE_ENV: 'test' });
    loadRuntimeConfig({ VITEST: 'true' });
    expect(dotenv.config).not.toHaveBeenCalled();
  });

  it('reads the .env file for a normal runtime', () => {
    loadRuntimeConfig({ NODE_ENV: 'development' });
    expect(dotenv.config).toHaveBeenCalledTimes(1);
  });
});
