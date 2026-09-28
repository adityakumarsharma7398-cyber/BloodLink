import express, { type RequestHandler } from 'express';
import { createAuthContextLoader, type AuthContextLoader } from '../../src/auth/contextLoader.js';
import { createAuthMiddleware } from '../../src/auth/middleware.js';
import type { TokenVerifier, VerifiedIdentity } from '../../src/auth/tokenVerifier.js';
import { parseConfig, type AppConfig } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import type { AppDeps } from '../../src/container.js';
import type { Database, ProbeResult } from '../../src/db/client.js';
import { createRateLimiters } from '../../src/http/rateLimit.js';
import { requestContext } from '../../src/http/requestContext.js';
import { createSecureRouter, RouteRegistry } from '../../src/http/secureRouter.js';
import { silentLogger } from '../../src/lib/logger.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';
import { HttpError } from '../../src/utils/httpError.js';
import type { Probe } from '../../src/services/probes.js';
import type { AiServiceClient } from '../../src/services/ai/aiServiceClient.js';

/**
 * Test-only helpers. Nothing here reads the developer's `.env`: configuration is parsed from an
 * explicit object, and tokens are verified by a stub that never contacts Supabase.
 */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

/** Test tokens look like `test-<userId>`; anything else is rejected exactly like a bad real token. */
export const tokenFor = (userId: string) => `test-${userId}`;

export function stubTokenVerifier(): TokenVerifier {
  return {
    async verify(token): Promise<VerifiedIdentity> {
      const match = /^test-([0-9a-f-]{36})$/.exec(token);
      if (!match) throw new HttpError(401, 'Invalid or expired token', 'INVALID_TOKEN');
      return { userId: match[1]!, email: null };
    },
  };
}

export const upProbe: Probe = async () => ({ status: 'up', latencyMs: 1 });
export const downProbe: Probe = async () => ({ status: 'down', reason: 'UNREACHABLE' });

/**
 * Default test AI client: always "unreachable", so every existing test keeps exercising the
 * trailing-average baseline unless a test explicitly injects `fakeAiClient(...)` with a response.
 */
export function fakeAiClient(handler?: (path: string, body: unknown) => unknown): AiServiceClient {
  return {
    async call<T>(path: string, init?: { body?: unknown }): Promise<T> {
      if (!handler) throw new HttpError(503, 'AI service is unreachable', 'AI_SERVICE_UNAVAILABLE');
      return handler(path, init?.body) as T;
    },
  };
}

/** A Database double for tests that never touch a database (probe result is configurable). */
export function fakeDatabase(probe: ProbeResult = { ok: true, latencyMs: 1 }): Database {
  return {
    prisma: new Proxy({}, { get: () => { throw new Error('fakeDatabase.prisma must not be used'); } }) as Database['prisma'],
    configured: probe.ok || probe.reason !== 'NOT_CONFIGURED',
    withTransaction: async () => { throw new Error('fakeDatabase.withTransaction must not be used'); },
    probe: async () => probe,
    disconnect: async () => {},
  };
}

export function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    config: testConfig(),
    logger: silentLogger,
    db: fakeDatabase(),
    tokenVerifier: stubTokenVerifier(),
    probes: { database: upProbe, ai: upProbe, supabase: upProbe },
    aiClient: fakeAiClient(),
    ...overrides,
  };
}

export const buildApp = (overrides: Partial<AppDeps> = {}) => createApp(buildDeps(overrides));

/**
 * A minimal app with the REAL guards and error handling, plus caller-supplied test routes, for
 * exercising authorization rules without depending on business endpoints (which do not exist yet).
 */
export function buildGuardApp(
  deps: Pick<AppDeps, 'db' | 'tokenVerifier'> & { loadContext?: AuthContextLoader },
  mount: (secure: (base: string) => ReturnType<typeof createSecureRouter>, auth: ReturnType<typeof createAuthMiddleware>) => void,
) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  const registry = new RouteRegistry();
  const auth = createAuthMiddleware({
    tokenVerifier: deps.tokenVerifier,
    loadContext: deps.loadContext ?? createAuthContextLoader(deps.db.prisma),
    logger: silentLogger,
  });
  const limiters = createRateLimiters({ publicPerMinute: 1000, authFailuresPer15Min: 1000 });
  const routers: [string, ReturnType<typeof createSecureRouter>][] = [];
  mount((base) => {
    const secure = createSecureRouter({ basePath: base, auth, limiters, registry });
    routers.push([base, secure]);
    return secure;
  }, auth);
  for (const [base, secure] of routers) app.use(base, secure.router);
  app.use(createErrorHandler(silentLogger) as unknown as RequestHandler);
  return Object.assign(app, { routeRegistry: registry });
}
