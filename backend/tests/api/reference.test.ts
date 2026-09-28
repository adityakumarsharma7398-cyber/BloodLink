import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../db/fixtures.js';
import { buildApp, testConfig, tokenFor } from '../support/testApp.js';
import { realDatabase, seedNetwork } from './harness.js';

const db = realDatabase();
const app = buildApp({ db });
let n: Network;

beforeAll(async () => {
  n = await seedNetwork();
});
afterAll(() => db.disconnect());

describe('GET /api/blood-groups', () => {
  it('is public and returns the 9 reference groups in display order', async () => {
    const res = await request(app).get('/api/blood-groups');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['data']);
    expect(res.body.data.map((g: { code: string }) => g.code)).toEqual(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+', 'UNKNOWN']);
    expect(res.body.data[0]).toEqual({ id: expect.any(Number), code: 'O-', displayName: 'O−', abo: 'O', rhd: '-', isKnown: true, sortOrder: 1 });
    expect(res.body.data.at(-1)).toMatchObject({ code: 'UNKNOWN', isKnown: false, abo: null, rhd: null });
  });

  it('exposes only the public columns and is cacheable', async () => {
    const res = await request(app).get('/api/blood-groups');
    for (const group of res.body.data) expect(Object.keys(group).sort()).toEqual(['abo', 'displayName', 'id', 'isKnown', 'rhd', 'sortOrder', 'code'].sort());
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('is the same for anonymous and signed-in callers (it follows the database’s public visibility)', async () => {
    const anonymous = await request(app).get('/api/blood-groups');
    for (const id of [n.user.drSharma, n.user.publicUser, n.user.donorUser, n.user.centreBAdmin]) {
      const res = await request(app).get('/api/blood-groups').set('Authorization', `Bearer ${tokenFor(id)}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(anonymous.body);
    }
  });

  it('an invalid token on a public route does not turn it into an error', async () => {
    // The public route never inspects the token, so it is not a way to probe tokens.
    expect((await request(app).get('/api/blood-groups').set('Authorization', 'Bearer garbage-token-value')).status).toBe(200);
  });
});

describe('GET /api/components', () => {
  it('is public and returns the 4 MVP components', async () => {
    const res = await request(app).get('/api/components');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { code: string }) => c.code)).toEqual(['WHOLE_BLOOD', 'PRBC', 'PLASMA_FFP', 'PLATELETS']);
    expect(res.body.data[1]).toEqual({ id: expect.any(Number), code: 'PRBC', name: 'Packed red blood cells', category: 'RED_CELLS', active: true });
  });

  it('never exposes storage values, shelf life or validation/approver metadata', async () => {
    const res = await request(app).get('/api/components');
    for (const component of res.body.data) expect(Object.keys(component).sort()).toEqual(['active', 'category', 'code', 'id', 'name']);
    expect(JSON.stringify(res.body)).not.toMatch(/storage|temp|shelf|valid|source|approver|typical/i);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('public endpoints are rate limited per client', () => {
  it('answers 429 RATE_LIMITED once the public limit is exceeded', async () => {
    const limited = buildApp({ db, config: testConfig({ RATE_LIMIT_PUBLIC_PER_MINUTE: '4' }) });
    for (let i = 0; i < 4; i += 1) expect((await request(limited).get('/api/components')).status).toBe(200);
    const blocked = await request(limited).get('/api/components');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    // the two public reference endpoints share the limit of the calling client
    expect((await request(limited).get('/api/blood-groups')).status).toBe(429);
  });

  it('does not throttle authenticated traffic on /api/auth/me', async () => {
    const limited = buildApp({ db, config: testConfig({ RATE_LIMIT_PUBLIC_PER_MINUTE: '1' }) });
    for (let i = 0; i < 12; i += 1) {
      expect((await request(limited).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(n.user.drSharma)}`)).status).toBe(200);
    }
  });
});
