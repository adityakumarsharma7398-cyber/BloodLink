import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseProbe } from '../../src/services/probes.js';
import type { Network } from '../db/fixtures.js';
import { buildApp, testConfig, tokenFor, upProbe } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork } from './harness.js';

// Liveness must not depend on the database; readiness must.
const db = realDatabase();
const deadDb = realDatabase('postgres://nobody:secret-pw-zz@127.0.0.1:1/nowhere');
let n: Network;
let superAdmin: string;

beforeAll(async () => {
  n = await seedNetwork();
  superAdmin = await createUser('HealthAdmin', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);
});
afterAll(async () => {
  await db.disconnect();
  await deadDb.disconnect();
});

const appFor = (database: typeof db) =>
  buildApp({ db: database, probes: { database: databaseProbe(database), ai: upProbe, supabase: upProbe }, config: testConfig() });

describe('GET /api/health (liveness)', () => {
  it('is 200 with a working database', async () => {
    expect((await request(appFor(db)).get('/api/health')).status).toBe(200);
  });

  it('is still 200 when the database is down', async () => {
    const res = await request(appFor(deadDb)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GET /api/health/ready (readiness)', () => {
  it('is 200 when the database answers', async () => {
    const res = await request(appFor(db)).get('/api/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('is 503 when the database is unreachable, with no connection detail', async () => {
    const res = await request(appFor(deadDb)).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|nowhere|secret-pw-zz|nobody|postgres/i);
  });
});

describe('GET /api/health/dependencies', () => {
  it('anonymous and ordinary staff see only an overall status', async () => {
    const app = appFor(deadDb);
    for (const headers of [{}, { Authorization: `Bearer ${tokenFor(n.user.drSharma)}` }, { Authorization: `Bearer ${tokenFor(n.user.publicUser)}` }]) {
      const res = await request(app).get('/api/health/dependencies').set(headers);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['status', 'timestamp']);
      expect(res.body.status).toBe('degraded');
    }
  });

  it('a platform super admin sees each dependency (fixed status codes only, never error text)', async () => {
    // identity/roles come from the working database; only the probed database is the dead one
    const app = buildApp({ db, probes: { database: databaseProbe(deadDb), ai: upProbe, supabase: upProbe }, config: testConfig() });
    const res = await request(app).get('/api/health/dependencies').set('Authorization', `Bearer ${tokenFor(superAdmin)}`);
    expect(res.status).toBe(200);
        expect(res.body.dependencies.database).toEqual({ status: 'down', reason: 'UNREACHABLE' });
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|nowhere|secret-pw-zz|nobody|postgres/i);

    const healthy = await request(appFor(db)).get('/api/health/dependencies').set('Authorization', `Bearer ${tokenFor(superAdmin)}`);
    expect(healthy.body.dependencies.database.status).toBe('up');
    expect(healthy.body.status).toBe('ok');
  });
});
