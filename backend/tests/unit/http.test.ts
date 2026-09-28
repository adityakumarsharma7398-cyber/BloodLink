import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AuthContextLoader } from '../../src/auth/contextLoader.js';
import { HttpError } from '../../src/utils/httpError.js';
import { context, USERS } from '../support/contexts.js';
import { buildApp, downProbe, fakeDatabase, testConfig, tokenFor, upProbe } from '../support/testApp.js';

const USER_ID = '3f6f9c3e-5b0a-4f6e-9d1a-0e6b1c2d3e4f';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loaderFor = (ctx = USERS.doctor): AuthContextLoader => async () => ctx;
const bearer = (id = USER_ID) => ({ Authorization: `Bearer ${tokenFor(id)}` });
const LEAKY = /select |insert |prisma|postgres:\/\/|stack|node_modules|\.ts:\d+/i;

describe('health', () => {
  it('GET /api/health is lightweight and does not depend on the database', async () => {
    const app = buildApp({ db: fakeDatabase({ ok: false, reason: 'UNREACHABLE' }), probes: { database: downProbe, ai: downProbe, supabase: downProbe } });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'bloodlink-backend' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/health/ready is 200 when the database is reachable and 503 when it is not, with no detail', async () => {
    const up = await request(buildApp()).get('/api/health/ready');
    expect(up.status).toBe(200);
    expect(Object.keys(up.body).sort()).toEqual(['status', 'timestamp']);
    expect(up.body.status).toBe('ready');

    const down = await request(buildApp({ probes: { database: downProbe, ai: upProbe, supabase: upProbe } })).get('/api/health/ready');
    expect(down.status).toBe(503);
    expect(Object.keys(down.body).sort()).toEqual(['status', 'timestamp']);
    expect(down.body.status).toBe('not_ready');
  });

  it('GET /api/health/dependencies gives anonymous callers only the overall status', async () => {
    const app = buildApp({ probes: { database: downProbe, ai: upProbe, supabase: upProbe } });
    for (const headers of [{}, bearer(), { Authorization: 'Bearer garbage-token-value' }]) {
      const res = await request(app).get('/api/health/dependencies').set(headers);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['status', 'timestamp']);
      expect(res.body.status).toBe('degraded');
    }
  });

  it('shows per-dependency detail only to a platform super admin, and never raw error text', async () => {
    const app = buildApp({ loadContext: loaderFor(USERS.superAdmin), probes: { database: downProbe, ai: upProbe, supabase: upProbe } });
    const res = await request(app).get('/api/health/dependencies').set(bearer());
    expect(res.status).toBe(200);
    expect(res.body.dependencies.database).toEqual({ status: 'down', reason: 'UNREACHABLE' });
    expect(res.body.dependencies.aiService.status).toBe('up');
    expect(res.body.adapters).toEqual({ maps: 'mock', notifications: 'inapp', eraktkosh: 'mock' });

    const notAdmin = buildApp({ loadContext: loaderFor(USERS.orgAdmin), probes: { database: downProbe, ai: upProbe, supabase: upProbe } });
    const denied = await request(notAdmin).get('/api/health/dependencies').set(bearer());
    expect(Object.keys(denied.body).sort()).toEqual(['status', 'timestamp']);
  });
});

describe('error responses', () => {
  it('malformed JSON is a 400 INVALID_JSON, not a 500, and echoes nothing from the body', async () => {
    const res = await request(buildApp()).post('/api/health').set('Content-Type', 'application/json').send('{"secret": zz-SECRET-9,}');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_JSON' });
    expect(JSON.stringify(res.body)).not.toContain('zz-SECRET-9');
  });

  it('oversized bodies are a 413', async () => {
    const res = await request(buildApp()).post('/api/health').set('Content-Type', 'application/json').send(JSON.stringify({ x: 'a'.repeat(1_200_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('unknown routes are a structured 404', async () => {
    const res = await request(buildApp()).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('every response carries a server-generated request id that matches the error body', async () => {
    const res = await request(buildApp()).get('/api/nope').set('X-Request-Id', 'client-chosen-id');
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.headers['x-request-id']).not.toBe('client-chosen-id');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('an unexpected exception is an opaque 500 with no internals', async () => {
    const boom = async () => {
      throw new Error('SELECT secret FROM users WHERE password = postgres://u:p@host/db at /srv/x.ts:1');
    };
    const res = await request(buildApp({ probes: { database: boom, ai: upProbe, supabase: upProbe } })).get('/api/health/ready');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(LEAKY);
  });

  it('answers 503 REQUEST_TIMEOUT when a handler is too slow', async () => {
    const slow = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      return { status: 'up' as const };
    };
    const app = buildApp({ config: testConfig({ REQUEST_TIMEOUT_MS: '1000' }), probes: { database: slow, ai: upProbe, supabase: upProbe } });
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
  });
});

describe('authentication (GET /api/auth/me)', () => {
  it('requires a bearer token', async () => {
    const app = buildApp({ loadContext: loaderFor() });
    for (const headers of [{}, { Authorization: '' }, { Authorization: 'Basic abcdefghijk' }, { Authorization: 'Bearer' }, { Authorization: 'Bearer a b c' }]) {
      const res = await request(app).get('/api/auth/me').set(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    }
  });

  it('rejects a token the verifier does not accept', async () => {
    const res = await request(buildApp({ loadContext: loaderFor() })).get('/api/auth/me').set('Authorization', 'Bearer not-a-valid-token-1');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns the server-resolved context and nothing else', async () => {
    const res = await request(buildApp({ loadContext: loaderFor(USERS.doctor) })).get('/api/auth/me').set(bearer());
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(Object.keys(res.body.data).sort()).toEqual(['facilities', 'organization', 'primaryFacilityId', 'roles', 'user']);
    expect(res.body.data.roles).toEqual([{ role: 'DOCTOR', scope: 'FACILITY', organizationId: USERS.doctor.organization!.id, facilityId: USERS.doctor.grants[0]!.facilityId }]);
    expect(JSON.stringify(res.body)).not.toMatch(/token|eyJ|secret|password|service_role/i);
  });

  it('passes on the loader failures (unprovisioned, inactive user, inactive organization) as 403s', async () => {
    for (const code of ['USER_NOT_PROVISIONED', 'USER_INACTIVE', 'ORGANIZATION_INACTIVE']) {
      const loadContext: AuthContextLoader = async () => {
        throw new HttpError(403, 'nope', code);
      };
      const res = await request(buildApp({ loadContext })).get('/api/auth/me').set(bearer());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(code);
    }
  });

  it('shows no permissions for a user with no grants (authenticated is not authorized)', async () => {
    const res = await request(buildApp({ loadContext: loaderFor(context()) })).get('/api/auth/me').set(bearer());
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual([]);
    expect(res.body.data.facilities).toEqual([]);
  });
});

describe('every route declares an access policy', () => {
  const routes = () => buildApp().routeRegistry.routes;

  it('registers exactly the approved routes, and only the reference/health routes are public and inventory is role-gated', () => {
    expect(routes().map((r) => `${r.method} ${r.path} ${r.policy}`).sort()).toEqual([
      'GET /api/auth/me authenticated',
      'GET /api/blood-groups public',
      'GET /api/components public',
      'GET /api/health public',
      'GET /api/health/dependencies public',
      'GET /api/health/ready public',
      'GET /api/emergency/incoming anyRole',
      'GET /api/emergency/requests anyRole',
      'GET /api/emergency/requests/:id anyRole',
      'POST /api/emergency/holds/confirm anyRole',
      'POST /api/emergency/holds/decline anyRole',
      'POST /api/emergency/requests anyRole',
      'POST /api/emergency/requests/:id/source-selection anyRole',
      'POST /api/emergency/source-selections/:id/decision anyRole',
      'GET /api/intelligence/predictions anyRole',
      'GET /api/intelligence/recommendations anyRole',
      'POST /api/intelligence/recommendations/:id/decision anyRole',
      'POST /api/intelligence/redistribution/runs anyRole',
      'POST /api/intelligence/runs anyRole',
      'GET /api/transfers anyRole',
      'GET /api/transfers/:id anyRole',
      'POST /api/transfers/:id/approve anyRole',
      'POST /api/transfers/:id/reject anyRole',
      'GET /api/inventory/summary anyRole',
      'GET /api/inventory/units anyRole',
      'GET /api/requests anyRole',
      'GET /api/requests/:id anyRole',
      'POST /api/requests anyRole',
      'POST /api/donor-activations/runs anyRole',
      'GET /api/donor-activations/mine anyRole',
      'POST /api/donor-activations/recipients/:recipientId/respond anyRole',
      'GET /api/donor-activations anyRole',
      'GET /api/donor-activations/:id anyRole',
      'POST /api/donor-activations/:id/notify anyRole',
      'POST /api/donor-activations/:id/cancel anyRole',
    ].map((line) => line.replace(' /api', ' /api')).sort());
  });

  it('no route file builds a raw Express Router (they must use createSecureRouter)', () => {
    const dir = path.resolve(import.meta.dirname, '../../src/routes');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/Router\(\)|from 'express'/);
    }
  });
});

describe('rate limiting', () => {
  it('limits public routes per client and answers 429 RATE_LIMITED with Retry-After', async () => {
    const app = buildApp({ config: testConfig({ RATE_LIMIT_PUBLIC_PER_MINUTE: '3' }) });
    for (let i = 0; i < 3; i += 1) expect((await request(app).get('/api/health/ready')).status).toBe(200);
    const blocked = await request(app).get('/api/health/ready');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('exempts liveness from the public limit', async () => {
    const app = buildApp({ config: testConfig({ RATE_LIMIT_PUBLIC_PER_MINUTE: '1' }) });
    for (let i = 0; i < 20; i += 1) expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('never throttles authenticated traffic with the public limit', async () => {
    const app = buildApp({ config: testConfig({ RATE_LIMIT_PUBLIC_PER_MINUTE: '1', RATE_LIMIT_AUTH_FAILURES_PER_15_MIN: '3' }), loadContext: loaderFor() });
    for (let i = 0; i < 25; i += 1) expect((await request(app).get('/api/auth/me').set(bearer())).status).toBe(200);
  });

  it('counts only failed authentications toward the auth-failure limit', async () => {
    const app = buildApp({ config: testConfig({ RATE_LIMIT_AUTH_FAILURES_PER_15_MIN: '3' }), loadContext: loaderFor() });
    for (let i = 0; i < 3; i += 1) expect((await request(app).get('/api/auth/me')).status).toBe(401);
    const blocked = await request(app).get('/api/auth/me');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('CORS and security headers', () => {
  it('allows configured origins only and exposes the request id', async () => {
    const app = buildApp();
    const ok = await request(app).options('/api/health').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const other = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const res = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });

  it('sets helmet headers and hides the framework', async () => {
    const res = await request(buildApp()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
