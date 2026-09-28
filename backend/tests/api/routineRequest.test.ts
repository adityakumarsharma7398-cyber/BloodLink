import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../db/fixtures.js';
import { buildApp, testConfig, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork, withPg } from './harness.js';

/**
 * The routine (non-emergency) hospital request workflow: HOSPITAL_STAFF and DOCTOR create and track
 * requests for their own facility. This reuses the same `requests`/`request_items` tables and DTO
 * shape as the emergency workflow (§3.13–3.14) — only `request_type = 'ROUTINE'` and the role gate
 * differ. No source-side action (hold confirm/decline, dispatch, transfer, issue) is reachable here.
 */
const db = realDatabase();
const app = buildApp({ db, config: testConfig() });
let n: Network;
let superAdmin: string;

const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (path: string, userId?: string) => (userId ? request(app).get(path).set(as(userId)) : request(app).get(path));
const post = (path: string, body: unknown, userId?: string) =>
  userId ? request(app).post(path).set(as(userId)).send(body as object) : request(app).post(path).send(body as object);
const rows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const drSharma = () => n.user.drSharma; // DOCTOR + HOSPITAL_STAFF at ABC Hospital
const newRequest = (over: Record<string, unknown> = {}, userId = drSharma()) =>
  post('/api/requests', { facilityId: n.fac.abcHospital, bloodGroupId: n.bg['O+'], componentId: n.comp.PRBC, quantity: 2, urgency: 'NORMAL', requiredBy: inHours(24), ...over }, userId);

beforeAll(async () => {
  n = await seedNetwork();
  superAdmin = await createUser('RoutineSuper', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);
});

afterAll(async () => {
  await db.disconnect();
});

describe('access control', () => {
  it('requires authentication on every endpoint', async () => {
    for (const [method, path] of [['get', '/api/requests'], ['post', '/api/requests'], ['get', `/api/requests/${randomUUID()}`]] as const) {
      expect((await request(app)[method](path)).status, path).toBe(401);
    }
  });

  it('only HOSPITAL_STAFF or DOCTOR use the routine-request endpoints', async () => {
    for (const userId of [n.user.sunriseStaff, n.user.centreAAdmin, n.user.abcOrgAdmin, n.user.centreBStaff, n.user.publicUser, n.user.donorUser, superAdmin]) {
      expect((await newRequest({}, userId)).status, userId).toBe(403);
      expect((await get('/api/requests', userId)).status, userId).toBe(403);
      expect((await get(`/api/requests/${randomUUID()}`, userId)).status, userId).toBe(403);
    }
  });

  it('a HOSPITAL_STAFF user at a different facility gets 404, not another facility’s data (facility isolation)', async () => {
    const id = (await newRequest()).body.data.id; // created at ABC Hospital
    expect((await newRequest({}, n.user.metroStaff)).status).toBe(404); // facilityId defaults to ABC Hospital
    expect((await get(`/api/requests/${id}`, n.user.metroStaff)).status).toBe(404);
    expect((await get(`/api/requests?facilityId=${n.fac.abcHospital}`, n.user.metroStaff)).status).toBe(404);
  });

  it('staff can only create requests for their own facility; anything else looks like a missing facility', async () => {
    expect((await newRequest({ facilityId: n.fac.metro })).status).toBe(404);
    expect((await newRequest({ facilityId: randomUUID() })).status).toBe(404);
  });

  it('emergency authorization is unchanged: EMERGENCY_STAFF cannot use the routine endpoints, and HOSPITAL_STAFF/DOCTOR still cannot use the emergency ones', async () => {
    expect((await newRequest({}, n.user.sunriseStaff)).status).toBe(403);
    expect((await get('/api/requests', n.user.sunriseStaff)).status).toBe(403);
    expect((await post('/api/emergency/requests', { facilityId: n.fac.abcHospital, bloodGroupId: n.bg['O+'], componentId: n.comp.PRBC, quantity: 1, urgency: 'CRITICAL', requiredBy: inHours(6) }, drSharma())).status).toBe(403);
    expect((await get('/api/emergency/requests', drSharma())).status).toBe(403);
  });
});

describe('creating a verified routine request', () => {
  it('creates a ROUTINE request verified at creation, with one item, distinguishable from an emergency request', async () => {
    const res = await newRequest();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      requestNumber: expect.stringMatching(/^REQ-\d{4}-\d{6}$/), type: 'ROUTINE', urgency: 'NORMAL', status: 'OPEN',
      verification: { status: 'VERIFIED', method: 'STAFF_AT_CREATION', verifiedAt: expect.any(String) },
      facility: { id: n.fac.abcHospital, name: expect.stringContaining('ABC Hospital') }, sourceSelection: null,
      items: [{ bloodGroup: 'O+', component: 'PRBC', quantityRequested: 2, quantityFulfilled: 0, quantityRemaining: 2, holds: [] }],
    });
    // no unit identifiers, storage location, donor information or source-private notes are ever exposed
    expect(JSON.stringify(res.body)).not.toMatch(/donor|storage|unit_code/i);
    const [row] = await rows('select requester_user_id, verified_by, patient_reference, contact_phone, notes from public.requests where id = $1', [res.body.data.id]);
    expect(row).toEqual({ requester_user_id: drSharma(), verified_by: drSharma(), patient_reference: null, contact_phone: null, notes: null });
    const [entry] = await rows("select user_id, organization_id, facility_id, new_value from public.audit_logs where action = 'request.create' and entity_id = $1", [res.body.data.id]);
    expect(entry).toMatchObject({ user_id: drSharma(), organization_id: n.org.abc, facility_id: n.fac.abcHospital, new_value: { quantity: 2, urgency: 'NORMAL', request_type: 'ROUTINE' } });
  });

  it('DOCTOR (not just HOSPITAL_STAFF) can also create a routine request', async () => {
    const res = await newRequest({}, n.user.drSharma);
    expect(res.status).toBe(201);
  });

  it('rejects invalid input, including any patient or contact field', async () => {
    const bad: Record<string, unknown>[] = [
      { quantity: 0 }, { quantity: 101 }, { urgency: 'URGENT' }, { requiredBy: 'tomorrow' }, { bloodGroupId: 0 },
      { patientReference: 'Ravi K' }, { contactPhone: '9999999999' }, { notes: 'free text' }, { requestType: 'EMERGENCY' },
    ];
    for (const over of bad) expect((await newRequest(over)).status, JSON.stringify(over)).toBe(400);
    expect((await newRequest({ requiredBy: new Date(Date.now() - 60_000).toISOString() })).body.error.code).toBe('REQUIRED_BY_IN_PAST');
    expect((await newRequest({ componentId: 32_000 })).body.error.code).toBe('UNKNOWN_PRODUCT');
  });
});

describe('request visibility and tracking', () => {
  it('is visible to the requesting facility only', async () => {
    const id = (await newRequest()).body.data.id;
    expect((await get(`/api/requests/${id}`, drSharma())).status).toBe(200);
    expect((await get(`/api/requests/${id}`, n.user.sunriseStaff)).status).toBe(403); // no HOSPITAL_STAFF/DOCTOR role anywhere
    expect((await get(`/api/requests/${id}`, n.user.metroStaff)).status).toBe(404); // HOSPITAL_STAFF, but at a different facility
    expect((await get(`/api/requests/${randomUUID()}`, drSharma())).status).toBe(404);
    const list = await get(`/api/requests?facilityId=${n.fac.abcHospital}&pageSize=100`, drSharma());
    expect(list.status).toBe(200);
    expect(list.body.data.map((r: any) => r.id)).toContain(id);
    expect(list.body.data.every((r: any) => r.type === 'ROUTINE')).toBe(true);
    expect((await get('/api/requests?status=NOPE', drSharma())).status).toBe(400);
  });

  it('an emergency request created at the same facility never appears in the routine list or by id', async () => {
    const em = await post('/api/emergency/requests', { facilityId: n.fac.sunrise, bloodGroupId: n.bg['O-'], componentId: n.comp.PRBC, quantity: 1, urgency: 'CRITICAL', requiredBy: inHours(6) }, n.user.sunriseStaff);
    expect(em.status).toBe(201);
    expect((await get(`/api/requests/${em.body.data.id}`, drSharma())).status).toBe(404);
  });
});

describe('hospital users cannot perform source-side actions', () => {
  it('cannot confirm or decline a hold', async () => {
    expect((await post('/api/emergency/holds/confirm', { allocationIds: [randomUUID()] }, drSharma())).status).toBe(403);
    expect((await post('/api/emergency/holds/decline', { allocationIds: [randomUUID()], note: 'x' }, drSharma())).status).toBe(403);
  });

  it('cannot read or decide a transfer (dispatch/transfer stays staff-only)', async () => {
    expect((await get('/api/transfers', drSharma())).status).toBe(403);
    expect((await post(`/api/transfers/${randomUUID()}/approve`, { approvedQuantity: 1 }, drSharma())).status).toBe(403);
    expect((await post(`/api/transfers/${randomUUID()}/reject`, { reason: 'x' }, drSharma())).status).toBe(403);
  });

  it('cannot see the source-only incoming-holds view', async () => {
    expect((await get('/api/emergency/incoming', drSharma())).status).toBe(403);
  });
});
