import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventoryRepository } from '../../src/repositories/inventoryRepository.js';
import { resolveParameter } from '../../src/inventory/parameters.js';
import type { Network } from '../db/fixtures.js';
import { buildApp, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, revokeAllRoles, seedNetwork, withPg } from './harness.js';

const db = realDatabase();
const app = buildApp({ db });
let n: Network;
let manager: string;
let superAdmin: string;

const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (path: string, userId?: string) => {
  const req = request(app).get(path);
  return userId ? req.set(as(userId)) : req;
};

/** Creates one unit through the real lifecycle function; returns its id. */
async function unit(facilityId: string, group: 'O-' | 'A+', opts: { status?: 'AVAILABLE' | 'QUARANTINED'; expiresInDays?: number; component?: 'PRBC' | 'PLATELETS' } = {}) {
  return withPg(async (c) => {
    const { rows } = await c.query(
      `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '60 days',
         now() + ($5::numeric * interval '1 day'), 'INVENTORY_ADDED', $6, null) as id`,
      [`INV-${randomUUID()}`, facilityId, n.comp[opts.component ?? 'PRBC'], n.bg[group], opts.expiresInDays ?? 20, opts.status ?? 'AVAILABLE']);
    return rows[0].id as string;
  });
}
const move = (unitId: string, to: string) =>
  withPg((c) => c.query('select private.transition_unit_status($1::uuid, $2::public.inventory_unit_status, null)', [unitId, to]));
const setParameter = (key: string, value: unknown, scope: { org?: string; facility?: string; group?: 'O-'; component?: 'PRBC' }) =>
  withPg((c) =>
    c.query(
      `insert into public.planning_parameters (key, organization_id, facility_id, blood_group_id, component_id, value, description)
       values ($1, $2, $3, $4, $5, $6::jsonb, 'inventory api test')`,
      [key, scope.org ?? null, scope.facility ?? null, scope.group ? n.bg[scope.group] : null, scope.component ? n.comp[scope.component] : null, JSON.stringify(value)]));

const row = (body: { data: any[] }, facility: string, group: string, component = 'PRBC') =>
  body.data.find((r) => r.facility.id === facility && r.bloodGroup.code === group && r.component.code === component);

beforeAll(async () => {
  n = await seedNetwork();
  manager = await createUser('InvManager', n.org.abc, n.fac.centreA);
  await grantRole(manager, 'INVENTORY_MANAGER', n.org.abc, n.fac.centreA);
  superAdmin = await createUser('InvSuper', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);

  // Centre A, PRBC O-: 3 usable (expire in 3 / 20 / 40 days), 1 quarantined, 1 reserved, 1 already past expiry, 2 issued.
  await unit(n.fac.centreA, 'O-', { expiresInDays: 3 });
  await unit(n.fac.centreA, 'O-', { expiresInDays: 20 });
  await unit(n.fac.centreA, 'O-', { expiresInDays: 40 });
  await unit(n.fac.centreA, 'O-', { status: 'QUARANTINED', expiresInDays: 30 });
  await move(await unit(n.fac.centreA, 'O-', { expiresInDays: 25 }), 'RESERVED');
  await unit(n.fac.centreA, 'O-', { expiresInDays: -1 });
  await move(await unit(n.fac.centreA, 'O-', { expiresInDays: 15 }), 'ISSUED');
  await move(await unit(n.fac.centreA, 'O-', { expiresInDays: 16 }), 'ISSUED');
  await unit(n.fac.centreA, 'O-', { component: 'PLATELETS', expiresInDays: 5 });
  // Centre B belongs to another organization.
  for (let i = 0; i < 5; i += 1) await unit(n.fac.centreB, 'O-');
});

afterAll(async () => {
  await withPg((c) => c.query("delete from public.planning_parameters where description = 'inventory api test'"));
  await db.disconnect();
});

describe('access control', () => {
  const paths = ['/api/inventory/summary', `/api/inventory/units?facilityId=${'00000000-0000-4000-8000-000000000001'}`];

  it.each(paths)('%s requires authentication', async (path) => {
    expect((await get(path)).status).toBe(401);
    expect((await get(path).set('Authorization', 'Bearer garbage-token-value')).status).toBe(401);
  });

  it('roles without inventory access are forbidden: hospital staff, doctors, donors, public requesters, super admins', async () => {
    for (const userId of [n.user.drSharma, n.user.publicUser, n.user.donorUser, n.user.metroStaff, n.user.sunriseStaff, superAdmin]) {
      expect((await get('/api/inventory/summary', userId)).status, 'summary').toBe(403);
      expect((await get(`/api/inventory/units?facilityId=${n.fac.centreA}`, userId)).status, 'units').toBe(403);
    }
  });

  it('inventory roles of the facility can read it', async () => {
    for (const userId of [n.user.centreAAdmin, manager, n.user.abcOrgAdmin]) {
      expect((await get(`/api/inventory/summary?facilityId=${n.fac.centreA}`, userId)).status).toBe(200);
      expect((await get(`/api/inventory/units?facilityId=${n.fac.centreA}`, userId)).status).toBe(200);
    }
  });

  it('another organization gets 404 (the facility is not revealed), for both endpoints', async () => {
    for (const userId of [n.user.centreBAdmin, n.user.centreBStaff]) {
      expect((await get(`/api/inventory/summary?facilityId=${n.fac.centreA}`, userId)).status).toBe(404);
      expect((await get(`/api/inventory/units?facilityId=${n.fac.centreA}`, userId)).status).toBe(404);
    }
    // an unknown facility id looks identical
    expect((await get(`/api/inventory/units?facilityId=${randomUUID()}`, n.user.centreAAdmin)).status).toBe(404);
  });

  it('a role held at another facility of the same organization does not grant access', async () => {
    // Centre A admin has no grant at the hospital; ABC Hospital does not hold stock either
    expect((await get(`/api/inventory/units?facilityId=${n.fac.abcHospital}`, n.user.centreAAdmin)).status).toBe(404);
  });

  it('ignores any organization/facility/role a client tries to supply', async () => {
    const res = await request(app).get(`/api/inventory/summary?facilityId=${n.fac.centreA}`)
      .set({ ...as(n.user.centreBAdmin), 'X-Facility-Id': n.fac.centreA, 'X-Role': 'ORG_ADMIN', 'X-Organization-Id': n.org.abc });
    expect(res.status).toBe(404);
  });

  it('revoking the role takes effect on the very next request', async () => {
    const temp = await createUser('TempInv', n.org.abc, n.fac.centreA);
    await grantRole(temp, 'INVENTORY_MANAGER', n.org.abc, n.fac.centreA);
    expect((await get('/api/inventory/summary', temp)).status).toBe(200);
    await revokeAllRoles(temp);
    expect((await get('/api/inventory/summary', temp)).status).toBe(403);
  });
});

describe('summary scope', () => {
  it('without facilityId returns only the caller’s own inventory-holding facilities', async () => {
    const own = await get('/api/inventory/summary?includeEmpty=false', n.user.centreAAdmin);
    expect(new Set(own.body.data.map((r: any) => r.facility.id))).toEqual(new Set([n.fac.centreA]));
    const orgAdmin = await get('/api/inventory/summary?includeEmpty=false', n.user.abcOrgAdmin);
    expect(new Set(orgAdmin.body.data.map((r: any) => r.facility.id))).toEqual(new Set([n.fac.centreA])); // the hospital holds no stock
    const other = await get('/api/inventory/summary?includeEmpty=false', n.user.centreBAdmin);
    expect(new Set(other.body.data.map((r: any) => r.facility.id))).toEqual(new Set([n.fac.centreB]));
  });

  it('never leaks another organization’s stock into the caller’s numbers', async () => {
    const res = await get(`/api/inventory/summary?facilityId=${n.fac.centreA}`, n.user.centreAAdmin);
    expect(JSON.stringify(res.body)).not.toContain(n.fac.centreB);
    const b = await get('/api/inventory/summary?includeEmpty=false', n.user.centreBAdmin);
    expect(row(b.body, n.fac.centreB, 'O-')!.quantities.available).toBe(5);
    expect(row(b.body, n.fac.centreB, 'O-')!.quantities.onHand).toBe(5);
  });
});

describe('summary quantities (no configuration yet → statuses are UNKNOWN, never guessed)', () => {
  let body: { data: any[] };
  beforeAll(async () => {
    body = (await get(`/api/inventory/summary?facilityId=${n.fac.centreA}`, n.user.centreAAdmin)).body;
  });

  it('counts available, reserved, pending, expired-but-unmarked and on-hand per blood group × component', () => {
    const o = row(body, n.fac.centreA, 'O-')!;
    expect(o.quantities).toMatchObject({
      available: 3, // 3d / 20d / 40d; the expired unit is not usable even though its status is still AVAILABLE
      reserved: 1,
      pendingAcceptance: 1,
      inTransit: 0,
      expiredNotYetMarked: 1,
      onHand: 6, // 3 available + 1 expired-unmarked (still AVAILABLE) + 1 reserved + 1 quarantined
      expiringSoon: null, // window not configured
    });
    expect(new Date(o.quantities.nearestExpiry).getTime()).toBeGreaterThan(Date.now());
    expect(row(body, n.fac.centreA, 'O-', 'PLATELETS')!.quantities).toMatchObject({ available: 1, onHand: 1 });
  });

  it('shows zero stock as rows too (so a stock-out is visible), and the UNKNOWN blood group only when units exist', () => {
    const empty = row(body, n.fac.centreA, 'A+')!;
    expect(empty.quantities).toMatchObject({ available: 0, onHand: 0, reserved: 0 });
    expect(body.data.some((r) => r.bloodGroup.code === 'UNKNOWN')).toBe(false);
    expect(body.data.length).toBe(8 * 4);
  });

  it('includeEmpty=false lists only groups × components that have units', async () => {
    const res = await get(`/api/inventory/summary?facilityId=${n.fac.centreA}&includeEmpty=false`, n.user.centreAAdmin);
    expect(res.body.data.map((r: any) => `${r.bloodGroup.code}/${r.component.code}`).sort()).toEqual(['O-/PLATELETS', 'O-/PRBC']);
  });

  it('filters by blood group and component', async () => {
    const res = await get(`/api/inventory/summary?facilityId=${n.fac.centreA}&bloodGroupId=${n.bg['O-']}&componentId=${n.comp.PRBC}`, n.user.centreAAdmin);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].bloodGroup.code).toBe('O-');
  });

  it('reports UNKNOWN / NOT_CONFIGURED for shortage and expiry when no parameters exist', () => {
    const o = row(body, n.fac.centreA, 'O-')!;
    expect(o.shortage).toEqual({ status: 'UNKNOWN', riskLevel: null, daysOfCover: null, reason: 'NOT_CONFIGURED' });
    expect(o.expiry).toEqual({ status: 'UNKNOWN', warningDays: null, expiringUnits: null, reason: 'NOT_CONFIGURED' });
    expect(o.parameters).toEqual({ expiryWarningDays: null, consumptionWindowDays: null, riskBands: null, issuedInWindow: null });
  });
});

describe('status from configured planning parameters', () => {
  const summary = async (facilityId = n.fac.centreA, userId = n.user.centreAAdmin) =>
    row((await get(`/api/inventory/summary?facilityId=${facilityId}`, userId)).body, facilityId, 'O-')!;

  it('expiry risk uses the configured warning window', async () => {
    await setParameter('expiry.warning_days', 7, { org: n.org.abc });
    const o = await summary();
    expect(o.quantities.expiringSoon).toBe(1); // only the 3-day unit is inside 7 days
    expect(o.expiry).toEqual({ status: 'AT_RISK', warningDays: 7, expiringUnits: 1 });
  });

  it('a component-specific window overrides the organization window', async () => {
    await setParameter('expiry.warning_days', 2, { org: n.org.abc, component: 'PRBC' });
    const o = await summary();
    expect(o.expiry).toEqual({ status: 'OK', warningDays: 2, expiringUnits: 0 });
  });

  it('shortage is UNKNOWN until thresholds AND a consumption window exist', async () => {
    await setParameter('coverage.risk_bands', { criticalBelowDays: 5, highBelowDays: 10, mediumBelowDays: 20 }, { org: n.org.abc });
    expect((await summary()).shortage).toMatchObject({ status: 'UNKNOWN', reason: 'NOT_CONFIGURED' });
  });

  it('classifies days of cover from units actually issued in the window', async () => {
    await setParameter('forecast.history_days', 10, { org: n.org.abc });
    const o = await summary();
    // 2 issued in 10 days = 0.2/day; 3 usable units → 15 days of cover → MEDIUM (10 ≤ 15 < 20)
    expect(o.parameters).toMatchObject({ consumptionWindowDays: 10, issuedInWindow: 2 });
    expect(o.shortage).toEqual({ status: 'SHORTAGE', riskLevel: 'MEDIUM', daysOfCover: 15 });
  });

  it('a facility-level threshold overrides the organization threshold', async () => {
    await setParameter('coverage.risk_bands', { criticalBelowDays: 3, highBelowDays: 5, mediumBelowDays: 10 }, { org: n.org.abc, facility: n.fac.centreA });
    expect((await summary()).shortage).toEqual({ status: 'HEALTHY', riskLevel: 'LOW', daysOfCover: 15 });
  });

  it('a combination with no consumption history is UNKNOWN (no invented demand)', async () => {
    const res = await get(`/api/inventory/summary?facilityId=${n.fac.centreA}`, n.user.centreAAdmin);
    expect(row(res.body, n.fac.centreA, 'A+')!.shortage).toMatchObject({ status: 'UNKNOWN', reason: 'NO_CONSUMPTION_HISTORY' });
  });

  it('an invalid configured value is reported as INVALID_PARAMETER, not silently used', async () => {
    await setParameter('coverage.risk_bands', { criticalBelowDays: 9, highBelowDays: 5, mediumBelowDays: 10 }, { org: n.org.abc, facility: n.fac.centreA, group: 'O-' });
    expect((await summary()).shortage).toMatchObject({ status: 'UNKNOWN', reason: 'INVALID_PARAMETER' });
  });

  it('parameters of one organization never apply to another', async () => {
    const other = row((await get('/api/inventory/summary?includeEmpty=false', n.user.centreBAdmin)).body, n.fac.centreB, 'O-')!;
    expect(other.expiry.status).toBe('UNKNOWN');
    expect(other.shortage.status).toBe('UNKNOWN');
  });

  it('the TypeScript resolver matches private.resolve_parameter for the same data', async () => {
    const rows = await inventoryRepository.parameterRows(db.prisma, [n.org.abc]);
    const combos = [
      { key: 'expiry.warning_days', bg: 'O-' as const, comp: 'PRBC' as const },
      { key: 'expiry.warning_days', bg: 'O-' as const, comp: 'PLATELETS' as const },
      { key: 'coverage.risk_bands', bg: 'O-' as const, comp: 'PRBC' as const },
      { key: 'coverage.risk_bands', bg: 'A+' as const, comp: 'PRBC' as const },
      { key: 'forecast.history_days', bg: 'A+' as const, comp: 'PLATELETS' as const },
    ];
    for (const { key, bg, comp } of combos) {
      const fromDb = await withPg(async (c) =>
        (await c.query('select private.resolve_parameter($1, $2::uuid, $3::smallint, $4::smallint) as v', [key, n.fac.centreA, n.bg[bg], n.comp[comp]])).rows[0].v);
      const scope = { facilityId: n.fac.centreA, organizationId: n.org.abc, bloodGroupId: n.bg[bg], componentId: n.comp[comp] };
      expect(resolveParameter(rows, key, scope), `${key} ${bg} ${comp}`).toEqual(fromDb);
    }
  });
});

describe('GET /api/inventory/units', () => {
  const units = (query = '', userId = n.user.centreAAdmin) => get(`/api/inventory/units?facilityId=${n.fac.centreA}${query}`, userId);

  it('lists the facility’s units first-expiry-first with pagination metadata', async () => {
    const res = await units('&pageSize=100');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 100, total: 9, totalPages: 1 });
    const expiries = res.body.data.map((u: any) => new Date(u.expiryDate).getTime());
    expect(expiries).toEqual([...expiries].sort((a, b) => a - b));
    expect(res.body.data[0]).toEqual({
      id: expect.any(String), unitCode: expect.stringMatching(/^INV-/), bloodGroup: { id: expect.any(Number), code: 'O-' },
      component: { id: expect.any(Number), code: expect.any(String) }, status: expect.any(String),
      collectionDate: expect.any(String), processingDate: null, expiryDate: expect.any(String), isExpired: true,
      volumeMl: null, statusChangedAt: expect.any(String), receivedAt: expect.any(String), storageLocationId: null, reservedForRequestId: null,
    });
    expect(res.body.data[0].isExpired).toBe(true);
    expect(res.body.data.filter((u: any) => u.isExpired)).toHaveLength(1);
  });

  it('pages and never repeats a unit across pages', async () => {
    const first = await units('&pageSize=4&page=1');
    const second = await units('&pageSize=4&page=2');
    const third = await units('&pageSize=4&page=3');
    expect(first.body.pagination).toMatchObject({ total: 9, totalPages: 3 });
    const ids = [...first.body.data, ...second.body.data, ...third.body.data].map((u: any) => u.id);
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
    expect((await units('&pageSize=4&page=4')).body.data).toEqual([]);
  });

  it('filters by status, blood group, component and expiry window', async () => {
    expect((await units('&status=QUARANTINED')).body.data).toHaveLength(1);
    expect((await units('&status=RESERVED')).body.data).toHaveLength(1);
    expect((await units('&status=ISSUED')).body.data).toHaveLength(2);
    expect((await units(`&componentId=${n.comp.PLATELETS}`)).body.data).toHaveLength(1);
    expect((await units(`&bloodGroupId=${n.bg['A+']}`)).body.data).toHaveLength(0);
    const soon = await units('&status=AVAILABLE&expiringWithinDays=5');
    expect(soon.body.data.length).toBeGreaterThanOrEqual(1);
    for (const u of soon.body.data) expect(new Date(u.expiryDate).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 86_400_000);
  });

  it('never returns another facility’s units', async () => {
    const res = await units('&pageSize=100');
    const b = await get(`/api/inventory/units?facilityId=${n.fac.centreB}&pageSize=100`, n.user.centreBAdmin);
    const aCodes = new Set(res.body.data.map((u: any) => u.unitCode));
    for (const u of b.body.data) expect(aCodes.has(u.unitCode)).toBe(false);
    expect(b.body.pagination.total).toBe(5);
  });

  it('exposes no donor, donation or patient fields', async () => {
    const res = await units();
    expect(JSON.stringify(res.body)).not.toMatch(/donor|donation|patient/i);
  });

  it('validates the query strictly', async () => {
    const bad = [
      `/api/inventory/units`, // facilityId required
      `/api/inventory/units?facilityId=not-a-uuid`,
      `/api/inventory/units?facilityId=${n.fac.centreA}&status=NOPE`,
      `/api/inventory/units?facilityId=${n.fac.centreA}&pageSize=101`,
      `/api/inventory/units?facilityId=${n.fac.centreA}&page=0`,
      `/api/inventory/units?facilityId=${n.fac.centreA}&expiringWithinDays=0`,
      `/api/inventory/units?facilityId=${n.fac.centreA}&unknown=1`,
      `/api/inventory/summary?facilityId=x`,
      `/api/inventory/summary?includeEmpty=maybe`,
    ];
    for (const path of bad) {
      const res = await get(path, n.user.centreAAdmin);
      expect(res.status, path).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('responses are not cacheable and carry a request id', async () => {
    const res = await units();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('read-only guarantee', () => {
  it('reading inventory writes nothing (no audit rows, no ledger rows, no unit changes)', async () => {
    const snapshot = () =>
      withPg(async (c) => (await c.query(
        `select (select count(*) from public.audit_logs)::int as audit, (select count(*) from public.transactions)::int as ledger,
                (select max(updated_at) from public.inventory_units) as touched, (select count(*) from public.inventory_units)::int as units`)).rows[0]);
    const before = await snapshot();
    await get('/api/inventory/summary', n.user.centreAAdmin);
    await get(`/api/inventory/units?facilityId=${n.fac.centreA}`, n.user.abcOrgAdmin);
    expect(await snapshot()).toEqual(before);
  });

  it('exposes no mutating inventory route', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/inventory/summary').set(as(n.user.centreAAdmin));
      expect(res.status).toBe(404);
    }
  });
});
