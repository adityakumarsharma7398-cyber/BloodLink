import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../db/fixtures.js';
import { buildApp, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, revokeAllRoles, seedNetwork, setStatus } from './harness.js';

// Authentication + database-resolved authorization context, through the real app, Prisma and PostgreSQL.
const db = realDatabase();
const app = buildApp({ db });
let n: Network;

beforeAll(async () => {
  n = await seedNetwork();
});
afterAll(() => db.disconnect());

const me = (userId: string) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(userId)}`);

describe('GET /api/auth/me — resolved from the database', () => {
  it('returns a doctor’s grants, organization and facilities', async () => {
    const res = await me(n.user.drSharma);
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.user).toMatchObject({ id: n.user.drSharma, fullName: 'DrSharma' });
    expect(data.organization).toMatchObject({ id: n.org.abc, type: 'HOSPITAL_BLOOD_CENTRE' });
    expect(data.primaryFacilityId).toBe(n.fac.abcHospital);
    expect(data.roles.map((r: { role: string }) => r.role).sort()).toEqual(['DOCTOR', 'HOSPITAL_STAFF']);
    for (const role of data.roles) expect(role).toMatchObject({ scope: 'FACILITY', organizationId: n.org.abc, facilityId: n.fac.abcHospital });
    expect(data.facilities).toEqual([{ id: n.fac.abcHospital, name: 'ABC Hospital', organizationId: n.org.abc, facilityType: 'HOSPITAL' }]);
  });

  it('gives an ORG_ADMIN every facility of its own organization, and none of another', async () => {
    const { data } = (await me(n.user.abcOrgAdmin)).body;
    expect(data.roles).toEqual([{ role: 'ORG_ADMIN', scope: 'ORGANIZATION', organizationId: n.org.abc, facilityId: null }]);
    expect(data.facilities.map((f: { id: string }) => f.id).sort()).toEqual([n.fac.abcHospital, n.fac.centreA].sort());
    expect(data.facilities.map((f: { id: string }) => f.id)).not.toContain(n.fac.centreB);
  });

  it('a blood-bank admin sees only their own facility', async () => {
    const { data } = (await me(n.user.centreBAdmin)).body;
    expect(data.facilities.map((f: { id: string }) => f.id)).toEqual([n.fac.centreB]);
    expect(data.organization.id).toBe(n.org.cbc);
  });

  it.each([['publicUser', 'PUBLIC_REQUESTER'], ['donorUser', 'DONOR']] as const)('%s (%s) gets no organization or facility', async (key, role) => {
    const { data } = (await me(n.user[key])).body;
    expect(data.organization).toBeNull();
    expect(data.primaryFacilityId).toBeNull();
    expect(data.facilities).toEqual([]);
    expect(data.roles).toEqual([{ role, scope: 'SELF', organizationId: null, facilityId: null }]);
  });

  it('exposes no token, claims, keys or connection details', async () => {
    const res = await me(n.user.drSharma);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ|bearer|secret|password|service_role|postgres:\/\/|test-[0-9a-f-]{36}/i);
  });
});

describe('authentication failures', () => {
  it('401 for a missing, malformed or invalid token', async () => {
    expect((await request(app).get('/api/auth/me')).body.error.code).toBe('AUTH_REQUIRED');
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Token abcdefghijk')).body.error.code).toBe('AUTH_REQUIRED');
    const invalid = await request(app).get('/api/auth/me').set('Authorization', 'Bearer not-a-real-token-at-all');
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe('INVALID_TOKEN');
  });

  it('403 USER_NOT_PROVISIONED for a genuine identity that has no BloodLink profile', async () => {
    const res = await me(randomUUID());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_NOT_PROVISIONED');
  });

  it.each(['INVITED', 'SUSPENDED', 'DEACTIVATED'])('403 USER_INACTIVE for a %s user, and access returns when reactivated', async (status) => {
    const id = await createUser(`Inactive${status}`, n.org.abc, n.fac.abcHospital);
    await grantRole(id, 'HOSPITAL_STAFF', n.org.abc, n.fac.abcHospital);
    expect((await me(id)).status).toBe(200);
    await setStatus('users', id, status);
    const res = await me(id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('USER_INACTIVE');
    await setStatus('users', id, 'ACTIVE');
    expect((await me(id)).status).toBe(200);
  });

  it.each(['PENDING', 'SUSPENDED'])('403 ORGANIZATION_INACTIVE when the user’s organization is %s', async (status) => {
    const other = await seedNetwork();
    expect((await me(other.user.drSharma)).status).toBe(200);
    await setStatus('organizations', other.org.abc, status);
    const res = await me(other.user.drSharma);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORGANIZATION_INACTIVE');
    // other organizations are unaffected
    expect((await me(other.user.centreBAdmin)).status).toBe(200);
  });
});

describe('the database, not the caller, decides what a user may do', () => {
  it('grants added or removed in the database show up on the very next request (no stale roles)', async () => {
    const id = await createUser('LateGrant', n.org.cbc, n.fac.centreB);
    expect((await me(id)).body.data.roles).toEqual([]);
    await grantRole(id, 'BLOOD_BANK_STAFF', n.org.cbc, n.fac.centreB);
    const granted = (await me(id)).body.data;
    expect(granted.roles.map((r: { role: string }) => r.role)).toEqual(['BLOOD_BANK_STAFF']);
    expect(granted.facilities.map((f: { id: string }) => f.id)).toEqual([n.fac.centreB]);
    await revokeAllRoles(id);
    const revoked = (await me(id)).body.data;
    expect(revoked.roles).toEqual([]);
    expect(revoked.facilities).toEqual([]);
  });

  it('roles, organization and facility supplied in headers, query or body are ignored', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .query({ role: 'SUPER_ADMIN', organization_id: n.org.cbc, facility_id: n.fac.centreB })
      .set('Authorization', `Bearer ${tokenFor(n.user.publicUser)}`)
      .set('X-Role', 'SUPER_ADMIN')
      .set('X-Organization-Id', n.org.cbc)
      .set('X-Facility-Id', n.fac.centreB);
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual([{ role: 'PUBLIC_REQUESTER', scope: 'SELF', organizationId: null, facilityId: null }]);
    expect(res.body.data.organization).toBeNull();
    expect(res.body.data.facilities).toEqual([]);
  });

  it('a grant in a suspended organization is dropped along with the whole login', async () => {
    const other = await seedNetwork();
    await setStatus('organizations', other.org.cbc, 'SUSPENDED');
    const res = await me(other.user.centreBAdmin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORGANIZATION_INACTIVE');
  });
});
