import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policy, requireFacilityAccess, requireOrganizationAccess } from '../../src/authz/policy.js';
import type { Network } from '../db/fixtures.js';
import { buildGuardApp, stubTokenVerifier, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork, setStatus } from './harness.js';

/**
 * Authorization guards exercised with the REAL guard middleware, the real database-backed context
 * loader and the real error handler, through test-only routes (no business endpoints exist yet).
 */
const db = realDatabase();
let n: Network;
let superAdmin: string;
let app: ReturnType<typeof buildGuardApp>;
const ok = (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ ok: true });

beforeAll(async () => {
  n = await seedNetwork();
  superAdmin = await createUser('PlatformAdmin', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);

  app = buildGuardApp({ db, tokenVerifier: stubTokenVerifier() }, (secure) => {
    const t = secure('/t');
    t.get('/public', policy.public(), ok);
    t.get('/authenticated', policy.authenticated(), ok);
    t.get('/doctor', policy.role('DOCTOR'), ok);
    t.get('/staff', policy.anyRole(['HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF', 'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER']), ok);
    t.get('/super', policy.role('SUPER_ADMIN'), ok);
    t.get('/bb-admin/:facilityId', policy.role('BLOOD_BANK_ADMIN', (req) => ({ facilityId: String(req.params.facilityId) })), ok);
    t.get('/org-admin/:orgId', policy.role('ORG_ADMIN', (req) => ({ organizationId: String(req.params.orgId) })), ok);
    t.get('/facility/:facilityId', policy.authenticated(), requireFacilityAccess((req) => String(req.params.facilityId)), ok);
    t.get('/org/:orgId', policy.authenticated(), requireOrganizationAccess((req) => String(req.params.orgId)), ok);
    // A facility named in the body only identifies the resource; it is checked against server-side grants.
    t.post('/doctor-at', policy.role('DOCTOR', (req) => ({ facilityId: String(req.body?.facilityId) })), ok);
  });
});
afterAll(() => db.disconnect());

const get = (path: string, userId?: string) => {
  const req = request(app).get(`/t${path}`);
  return userId ? req.set('Authorization', `Bearer ${tokenFor(userId)}`) : req;
};
const code = (res: request.Response) => res.body?.error?.code;

describe('deny by default', () => {
  it('protected routes need authentication; only routes that say so are public', async () => {
    expect((await get('/public')).status).toBe(200);
    for (const path of ['/authenticated', '/doctor', '/staff', '/super', `/bb-admin/${n.fac.centreB}`, `/facility/${n.fac.centreB}`]) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(code(res), path).toBe('AUTH_REQUIRED');
    }
  });

  it('a signed-in user with no matching role is forbidden, and the response does not say why', async () => {
    const res = await get('/doctor', n.user.centreBAdmin);
    expect(res.status).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toMatch(/DOCTOR|role|grant/i);
  });

  it('the route registry lists every test route with its policy', () => {
    const kinds = new Map(app.routeRegistry.routes.map((r) => [r.path, r.policy]));
    expect(kinds.get('/t/public')).toBe('public');
    expect(kinds.get('/t/doctor')).toBe('anyRole');
    expect(kinds.get('/t/authenticated')).toBe('authenticated');
  });
});

describe('role authorization', () => {
  it('lets a role reach the routes that name it', async () => {
    expect((await get('/doctor', n.user.drSharma)).status).toBe(200);
    expect((await get('/staff', n.user.drSharma)).status).toBe(200);
    expect((await get('/staff', n.user.centreBStaff)).status).toBe(200);
    expect((await get('/staff', n.user.sunriseStaff)).status).toBe(200);
    expect((await get('/super', superAdmin)).status).toBe(200);
  });

  it('a role does not grant another role', async () => {
    expect((await get('/super', n.user.abcOrgAdmin)).status).toBe(403);
    expect((await get('/doctor', n.user.abcOrgAdmin)).status).toBe(403);
    expect((await get('/staff', n.user.abcOrgAdmin)).status).toBe(403); // ORG_ADMIN is not on the staff list
    expect((await get('/doctor', n.user.centreBStaff)).status).toBe(403);
    expect((await get(`/bb-admin/${n.fac.centreB}`, n.user.centreBStaff)).status).toBe(403); // staff is not admin
  });
});

describe('PUBLIC_REQUESTER and DONOR restrictions', () => {
  it.each([['publicUser'], ['donorUser']] as const)('%s can authenticate but reaches no staff or scoped route', async (key) => {
    const id = n.user[key];
    expect((await get('/authenticated', id)).status).toBe(200);
    for (const path of ['/doctor', '/staff', '/super', `/bb-admin/${n.fac.centreB}`, `/org-admin/${n.org.abc}`, `/facility/${n.fac.abcHospital}`, `/facility/${n.fac.centreA}`, `/org/${n.org.abc}`, `/org/${n.org.cbc}`]) {
      const res = await get(path, id);
      expect(res.status, path).toBe(403);
      expect(code(res), path).toBe('FORBIDDEN');
    }
  });
});

describe('facility and organization scope', () => {
  it('a facility grant reaches that facility only — not a sibling facility of the same organization', async () => {
    expect((await get(`/facility/${n.fac.abcHospital}`, n.user.drSharma)).status).toBe(200);
    expect((await get(`/facility/${n.fac.centreA}`, n.user.drSharma)).status).toBe(403);
    expect((await get(`/org/${n.org.abc}`, n.user.drSharma)).status).toBe(200);
  });

  it('cross-organization access is denied in both directions', async () => {
    expect((await get(`/facility/${n.fac.centreB}`, n.user.drSharma)).status).toBe(403);
    expect((await get(`/facility/${n.fac.abcHospital}`, n.user.centreBAdmin)).status).toBe(403);
    expect((await get(`/org/${n.org.cbc}`, n.user.abcOrgAdmin)).status).toBe(403);
    expect((await get(`/org/${n.org.abc}`, n.user.centreBAdmin)).status).toBe(403);
    expect((await get(`/facility/${n.fac.abcHospital}`, n.user.metroStaff)).status).toBe(403);
    expect((await get(`/facility/${n.fac.abcHospital}`, n.user.sunriseStaff)).status).toBe(403);
  });

  it('role at a facility: allowed at own facility, denied at another', async () => {
    expect((await get(`/bb-admin/${n.fac.centreB}`, n.user.centreBAdmin)).status).toBe(200);
    expect((await get(`/bb-admin/${n.fac.centreA}`, n.user.centreBAdmin)).status).toBe(403);
    expect((await get(`/bb-admin/${n.fac.centreA}`, n.user.centreAAdmin)).status).toBe(200);
    expect((await get(`/bb-admin/${n.fac.centreB}`, n.user.centreAAdmin)).status).toBe(403);
  });

  it('ORG_ADMIN covers all facilities of its organization but not the ORG_ADMIN-less roles, and no other organization', async () => {
    expect((await get(`/facility/${n.fac.abcHospital}`, n.user.abcOrgAdmin)).status).toBe(200);
    expect((await get(`/facility/${n.fac.centreA}`, n.user.abcOrgAdmin)).status).toBe(200);
    expect((await get(`/facility/${n.fac.centreB}`, n.user.abcOrgAdmin)).status).toBe(403);
    expect((await get(`/org-admin/${n.org.abc}`, n.user.abcOrgAdmin)).status).toBe(200);
    expect((await get(`/org-admin/${n.org.cbc}`, n.user.abcOrgAdmin)).status).toBe(403);
    expect((await get(`/bb-admin/${n.fac.centreA}`, n.user.abcOrgAdmin)).status).toBe(403); // ORG_ADMIN is not BLOOD_BANK_ADMIN
  });

  it('SUPER_ADMIN is not a wildcard: platform routes only, no facility or organization access', async () => {
    expect((await get('/super', superAdmin)).status).toBe(200);
    expect((await get('/authenticated', superAdmin)).status).toBe(200);
    for (const path of [`/facility/${n.fac.centreA}`, `/org/${n.org.abc}`, `/bb-admin/${n.fac.centreA}`, '/doctor', '/staff']) {
      expect((await get(path, superAdmin)).status, path).toBe(403);
    }
  });
});

describe('client-supplied ids, roles and headers never grant anything', () => {
  it('ignores roles and organizations claimed in headers, query and body', async () => {
    const res = await request(app)
      .get(`/t/doctor`)
      .query({ role: 'DOCTOR', roles: 'DOCTOR,SUPER_ADMIN', organization_id: n.org.abc })
      .set('Authorization', `Bearer ${tokenFor(n.user.centreBAdmin)}`)
      .set('X-Role', 'DOCTOR')
      .set('X-Roles', 'SUPER_ADMIN')
      .set('X-Organization-Id', n.org.abc);
    expect(res.status).toBe(403);
  });

  it('a facility named in the request body is only a resource id, checked against server-side grants', async () => {
    const post = (userId: string, facilityId: string) =>
      request(app).post('/t/doctor-at').set('Authorization', `Bearer ${tokenFor(userId)}`).send({ facilityId, role: 'SUPER_ADMIN', organization_id: n.org.abc });
    expect((await post(n.user.drSharma, n.fac.abcHospital)).status).toBe(200);
    expect((await post(n.user.drSharma, n.fac.centreA)).status).toBe(403);
    expect((await post(n.user.drSharma, n.fac.centreB)).status).toBe(403);
    expect((await post(n.user.centreBAdmin, n.fac.abcHospital)).status).toBe(403);
  });
});

describe('account state is enforced on every request', () => {
  it('a suspended user loses access immediately, even with a valid token', async () => {
    const id = await createUser('SoonSuspended', n.org.abc, n.fac.abcHospital);
    await grantRole(id, 'DOCTOR', n.org.abc, n.fac.abcHospital);
    expect((await get('/doctor', id)).status).toBe(200);
    await setStatus('users', id, 'SUSPENDED');
    const res = await get('/doctor', id);
    expect(res.status).toBe(403);
    expect(code(res)).toBe('USER_INACTIVE');
  });
});
