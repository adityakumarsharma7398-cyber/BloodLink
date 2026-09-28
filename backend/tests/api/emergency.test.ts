import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haversineKm } from '../../src/intelligence/redistribution.js';
import { addDemoRules, setHoldTimeout, type Network } from '../db/fixtures.js';
import { buildApp, testConfig, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork, withPg } from './harness.js';

/**
 * Requesting facility: Sunrise Clinic (EMERGENCY_STAFF).  Sources: Centre A (ABC) and Centre B (City Blood Centre).
 * Compatibility rows are DEMO_ONLY test fixtures in a throwaway database — never clinical data.
 */
const db = realDatabase();
const demoApp = buildApp({ db, config: testConfig({ ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }) });
const strictApp = buildApp({ db }); // demo rules NOT allowed
let n: Network;
let superAdmin: string;
let staffB: string;
let otherEmergencyStaff: string; // EMERGENCY_STAFF, but at a different facility/organization

const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (path: string, userId?: string, app = demoApp) => (userId ? request(app).get(path).set(as(userId)) : request(app).get(path));
const post = (path: string, body: unknown, userId?: string, app = demoApp) =>
  userId ? request(app).post(path).set(as(userId)).send(body as object) : request(app).post(path).send(body as object);
const rows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function unit(facilityId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await rows(
      `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '60 days', now() + interval '30 days', 'INVENTORY_ADDED', 'AVAILABLE', null) as id`,
      [`EM-${randomUUID()}`, facilityId, n.comp.PRBC, n.bg['O-']]))[0].id);
  }
  return ids;
}
const issue = (id: string) => rows("select private.transition_unit_status($1::uuid, 'ISSUED', null)", [id]);
const param = (key: string, value: unknown, org: string) =>
  rows(`insert into public.planning_parameters (key, organization_id, value, description) values ($1, $2, $3::jsonb, 'emergency api test')`, [key, org, JSON.stringify(value)]);

const sunrise = () => n.user.sunriseStaff;
const newRequest = (over: Record<string, unknown> = {}, userId = sunrise()) =>
  post('/api/emergency/requests', { facilityId: n.fac.sunrise, bloodGroupId: n.bg['O-'], componentId: n.comp.PRBC, quantity: 4, urgency: 'CRITICAL', requiredBy: inHours(6), ...over }, userId);
const select = (requestId: string, userId = sunrise(), app = demoApp) => post(`/api/emergency/requests/${requestId}/source-selection`, {}, userId, app);
const decide = (recId: string, body: unknown, userId = sunrise()) => post(`/api/emergency/source-selections/${recId}/decision`, body, userId);
/** A fresh request with a pending source selection. */
async function pendingSelection(quantity = 4) {
  const requestId = (await newRequest({ quantity })).body.data.id as string;
  const sel = (await select(requestId)).body.data;
  return { requestId, sel };
}
const heldUnits = (requestId: string) => rows(
  `select a.id as allocation_id, a.status::text as allocation, u.status::text as unit, a.source_facility_id, a.hold_expires_at
   from public.request_allocations a join public.request_items i on i.id = a.request_item_id join public.inventory_units u on u.id = a.inventory_unit_id
   where i.request_id = $1 order by a.id`, [requestId]);

beforeAll(async () => {
  n = await seedNetwork();
  superAdmin = await createUser('EmSuper', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);
  staffB = n.user.centreBStaff;
  otherEmergencyStaff = await createUser('OtherEmergencyStaff', n.org.metro, n.fac.metro);
  await grantRole(otherEmergencyStaff, 'EMERGENCY_STAFF', n.org.metro, n.fac.metro);

  await withPg((c) => addDemoRules(c, n, ['O-']));
  for (const org of [n.org.abc, n.org.cbc]) {
    await param('forecast.history_days', 10, org);
    await param('forecast.horizon_days', 14, org);
    await param('reserve.floor_days', 10, org);
  }
  await param('eta.road_factor', 1.3, n.org.sunrise);
  await param('eta.urban_speed_kmh', 40, n.org.sunrise);
  await withPg(async (c) => {
    await setHoldTimeout(c, n.org.abc, n.fac.centreA, 30);
    await setHoldTimeout(c, n.org.cbc, n.fac.centreB, 45);
  });

  await unit(n.fac.centreA, 10); // spare above reserve = 10 (no consumption → no reserve)
  await unit(n.fac.centreB, 20);
  for (const id of await unit(n.fac.centreB, 5)) await issue(id); // demand 0.5/day → reserve ceil(10 × 0.5) = 5 → 20 usable − 5 = 15 spare
  // the sources' own current predictions (their demand) come from their own intelligence runs
  expect((await post('/api/intelligence/runs', { facilityId: n.fac.centreA }, n.user.centreAAdmin)).status).toBe(201);
  expect((await post('/api/intelligence/runs', { facilityId: n.fac.centreB }, n.user.centreBAdmin)).status).toBe(201);
});

afterAll(async () => {
  await rows("delete from public.planning_parameters where description in ('emergency api test', 'test fixture') and organization_id in ($1, $2, $3)", [n.org.abc, n.org.cbc, n.org.sunrise]);
  await rows('update public.facilities set accepts_temporary_holds = true where id in ($1, $2)', [n.fac.centreA, n.fac.centreB]);
  await rows('update public.organizations set shares_network_availability = true where id in ($1, $2)', [n.org.abc, n.org.cbc]);
  await db.disconnect();
});

describe('access control', () => {
  it('requires authentication on every endpoint', async () => {
    for (const [method, path] of [['get', '/api/emergency/requests'], ['post', '/api/emergency/requests'], ['get', '/api/emergency/incoming'], ['post', '/api/emergency/holds/confirm']] as const) {
      expect((await request(demoApp)[method](path)).status, path).toBe(401);
    }
  });

  it('only EMERGENCY_STAFF uses the requesting endpoints — not hospital staff, doctors, or anyone else (§9.2)', async () => {
    for (const userId of [n.user.drSharma, n.user.metroStaff, n.user.centreAAdmin, n.user.abcOrgAdmin, n.user.publicUser, n.user.donorUser, superAdmin]) {
      expect((await newRequest({}, userId)).status, userId).toBe(403);
      expect((await get('/api/emergency/requests', userId)).status, userId).toBe(403);
      expect((await post(`/api/emergency/requests/${randomUUID()}/source-selection`, {}, userId)).status, userId).toBe(403);
      expect((await decide(randomUUID(), { decision: 'APPROVE' }, userId)).status, userId).toBe(403);
    }
  });

  it('holding EMERGENCY_STAFF at a different facility still gets 404 there (facility scope is separate from the role gate)', async () => {
    const id = (await newRequest()).body.data.id; // created at Sunrise Clinic
    // otherEmergencyStaff holds EMERGENCY_STAFF, but at Metro Hospital, not at Sunrise Clinic
    expect((await newRequest({}, otherEmergencyStaff)).status).toBe(404); // facilityId defaults to Sunrise Clinic
    expect((await get(`/api/emergency/requests/${id}`, otherEmergencyStaff)).status).toBe(404);
    expect((await select(id, otherEmergencyStaff)).status).toBe(404);
  });

  it('only blood-bank staff use the source endpoints', async () => {
    for (const userId of [n.user.drSharma, n.user.sunriseStaff, n.user.abcOrgAdmin, n.user.publicUser, n.user.donorUser, superAdmin]) {
      expect((await get('/api/emergency/incoming', userId)).status).toBe(403);
      expect((await post('/api/emergency/holds/confirm', { allocationIds: [randomUUID()] }, userId)).status).toBe(403);
      expect((await post('/api/emergency/holds/decline', { allocationIds: [randomUUID()], note: 'x' }, userId)).status).toBe(403);
    }
  });

  it('staff can only create requests for their own facility; anything else looks like a missing facility', async () => {
    expect((await newRequest({ facilityId: n.fac.abcHospital })).status).toBe(404);
    expect((await newRequest({ facilityId: randomUUID() })).status).toBe(404);
    const forged = await request(demoApp).post('/api/emergency/requests').set({ ...as(sunrise()), 'X-Facility-Id': n.fac.abcHospital, 'X-Role': 'DOCTOR' })
      .send({ facilityId: n.fac.abcHospital, bloodGroupId: n.bg['O-'], componentId: n.comp.PRBC, quantity: 1, urgency: 'HIGH', requiredBy: inHours(2) });
    expect(forged.status).toBe(404);
  });
});

describe('creating a verified emergency request', () => {
  it('creates a request verified at creation by the authorized staff member, with one item', async () => {
    const res = await newRequest();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      requestNumber: expect.stringMatching(/^REQ-\d{4}-\d{6}$/), type: 'EMERGENCY', urgency: 'CRITICAL', status: 'OPEN',
      verification: { status: 'VERIFIED', method: 'STAFF_AT_CREATION', verifiedAt: expect.any(String) },
      facility: { id: n.fac.sunrise, name: expect.stringContaining('Sunrise') }, sourceSelection: null,
      items: [{ bloodGroup: 'O-', component: 'PRBC', quantityRequested: 4, quantityFulfilled: 0, quantityRemaining: 4, allowCompatibleSubstitutes: true, holds: [] }],
    });
    const [row] = await rows('select requester_user_id, verified_by, patient_reference, contact_phone, notes from public.requests where id = $1', [res.body.data.id]);
    expect(row).toEqual({ requester_user_id: sunrise(), verified_by: sunrise(), patient_reference: null, contact_phone: null, notes: null });
    const [entry] = await rows("select user_id, organization_id, facility_id, new_value from public.audit_logs where action = 'request.create' and entity_id = $1", [res.body.data.id]);
    expect(entry).toMatchObject({ user_id: sunrise(), organization_id: n.org.sunrise, facility_id: n.fac.sunrise, new_value: { quantity: 4, urgency: 'CRITICAL', verification_method: 'STAFF_AT_CREATION' } });
  });

  it('rejects invalid input, including any patient or contact field', async () => {
    const bad: Record<string, unknown>[] = [
      { quantity: 0 }, { quantity: 101 }, { urgency: 'URGENT' }, { requiredBy: 'tomorrow' }, { bloodGroupId: 0 },
      { patientReference: 'Ravi K' }, { contactPhone: '9999999999' }, { notes: 'free text' }, { requestType: 'ROUTINE' },
    ];
    for (const over of bad) expect((await newRequest(over)).status, JSON.stringify(over)).toBe(400);
    expect((await newRequest({ requiredBy: new Date(Date.now() - 60_000).toISOString() })).body.error.code).toBe('REQUIRED_BY_IN_PAST');
    expect((await newRequest({ componentId: 32_000 })).body.error.code).toBe('UNKNOWN_PRODUCT');
  });

  it('is visible to the requesting facility only', async () => {
    const id = (await newRequest()).body.data.id;
    expect((await get(`/api/emergency/requests/${id}`, sunrise())).status).toBe(200);
    expect((await get(`/api/emergency/requests/${id}`, n.user.drSharma)).status).toBe(403); // no EMERGENCY_STAFF role anywhere
    expect((await get(`/api/emergency/requests/${id}`, n.user.metroStaff)).status).toBe(403); // HOSPITAL_STAFF only, not EMERGENCY_STAFF
    expect((await get(`/api/emergency/requests/${randomUUID()}`, sunrise())).status).toBe(404);
    const list = await get(`/api/emergency/requests?facilityId=${n.fac.sunrise}&pageSize=100`, sunrise());
    expect(list.body.data.map((r: any) => r.id)).toContain(id);
    expect((await get(`/api/emergency/requests?facilityId=${n.fac.abcHospital}`, sunrise())).status).toBe(404);
    expect((await get('/api/emergency/requests?status=NOPE', sunrise())).status).toBe(400);
  });
});

describe('source selection uses the compatibility rules, never its own', () => {
  it('finds no source and says why when no compatibility rule may be used (demo rules not allowed)', async () => {
    const id = (await newRequest()).body.data.id;
    const res = await select(id, sunrise(), strictApp);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ranked: [], recommendationId: null, compatibility: { rulesFound: false, notice: null } });
    expect(await rows("select id from public.recommendations where related_request_id = $1", [id])).toHaveLength(0);
  });

  it('ranks the sources when demo rules are allowed and states that they are not clinically validated', async () => {
    const id = (await newRequest()).body.data.id;
    const res = await select(id);
    expect(res.body.data.compatibility).toEqual({ rulesFound: true, notice: 'COMPATIBILITY_RULES_NOT_CLINICALLY_VALIDATED' });
    const ranked = res.body.data.ranked.filter((r: any) => [n.fac.centreA, n.fac.centreB].includes(r.facility_id));
    const km = (lat: number, lon: number) => haversineKm(26.87, 80.98, lat, lon);
    const eta = (d: number) => Math.ceil(((d * 1.3) / 40) * 60);
    expect(ranked).toEqual([
      { facility_id: n.fac.centreA, facility_name: expect.stringContaining('Centre A'), can_fulfil: true, spare_units_above_reserve: 10, near_expiry_opportunity: false, distance_km: Math.round(km(26.85, 80.95) * 10) / 10, eta_minutes: eta(km(26.85, 80.95)), rank: 1 },
      { facility_id: n.fac.centreB, facility_name: expect.stringContaining('Centre B'), can_fulfil: true, spare_units_above_reserve: 15, near_expiry_opportunity: false, distance_km: Math.round(km(26.9, 81.02) * 10) / 10, eta_minutes: eta(km(26.9, 81.02)), rank: 2 },
    ]);
  });

  it('stores a pending EMERGENCY_SOURCE recommendation for a human, with explanations, and audits it', async () => {
    const { requestId, sel } = await pendingSelection();
    expect(sel.recommendationId).toEqual(expect.any(String));
    const [rec] = await rows('select * from public.recommendations where id = $1', [sel.recommendationId]);
    expect(rec).toMatchObject({
      recommendation_type: 'EMERGENCY_SOURCE', status: 'PENDING', priority: 'CRITICAL', source: 'SYSTEM_RULE', related_request_id: requestId,
      organization_id: n.org.sunrise, facility_id: n.fac.sunrise, decided_by: null,
    });
    expect(rec.action_explanation).toMatch(/no blood is released without that confirmation/);
    expect(rec.data_explanation.compatibility.notice).toBe('COMPATIBILITY_RULES_NOT_CLINICALLY_VALIDATED');
    expect(new Date(rec.valid_until).getTime()).toBeGreaterThan(Date.now());
    expect(await rows("select id from public.audit_logs where action = 'request.select_sources' and entity_id = $1", [requestId])).toHaveLength(1);
    const view = (await get(`/api/emergency/requests/${requestId}`, sunrise())).body.data;
    expect(view.sourceSelection).toMatchObject({ recommendationId: sel.recommendationId, priority: 'CRITICAL' });
  });

  it('PRIVACY: only the approved shared outputs per source; no demand, reserve, stock, expiry or unit data', async () => {
    const { sel } = await pendingSelection();
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); }
    };
    walk(sel.ranked);
    expect([...keys].sort()).toEqual(
      ['can_fulfil', 'distance_km', 'eta_minutes', 'facility_id', 'facility_name', 'near_expiry_opportunity', 'rank', 'spare_units_above_reserve'].sort(),
    );
    const [rec] = await rows('select payload, data_explanation from public.recommendations where id = $1', [sel.recommendationId]);
    expect(JSON.stringify(rec)).not.toMatch(/demand|floor|expiry_date|unit_code|usable|prediction/i);
    // the source's own figures never appear (Centre B: 25 units held, demand 0.5)
    expect(JSON.stringify(rec)).not.toContain('"usable');
  });

  it('respects reserve floors: a source cannot be asked for units it must keep, and it is told the need cannot be met', async () => {
    const id = (await newRequest({ quantity: 16 })).body.data.id; // Centre B holds 20 usable but must keep 5: only 15 are available to others
    const ranked = (await select(id)).body.data.ranked.filter((r: any) => [n.fac.centreA, n.fac.centreB].includes(r.facility_id));
    expect(ranked.map((r: any) => [r.facility_id, r.can_fulfil, r.spare_units_above_reserve])).toEqual([[n.fac.centreA, false, 10], [n.fac.centreB, false, 15]]);
  });

  it('offers nothing from a source whose reserve floor is not configured (no default reserve is assumed)', async () => {
    await rows("delete from public.planning_parameters where key = 'reserve.floor_days' and organization_id = $1", [n.org.cbc]);
    try {
      const res = (await select((await newRequest()).body.data.id)).body.data;
      expect(res.ranked.map((r: any) => r.facility_id)).not.toContain(n.fac.centreB);
      // the database aggregate does not offer a source whose reserve cannot be computed
      
    } finally {
      await param('reserve.floor_days', 10, n.org.cbc);
    }
  });

  it('lists a source that does not accept holds, or has no hold timeout, as not selectable', async () => {
    await rows('update public.facilities set accepts_temporary_holds = false where id = $1', [n.fac.centreA]);
    await rows("delete from public.planning_parameters where key = 'allocation.hold_timeout_minutes' and facility_id = $1", [n.fac.centreB]);
    try {
      const ranked = (await select((await newRequest()).body.data.id)).body.data.ranked.filter((r: any) => [n.fac.centreA, n.fac.centreB].includes(r.facility_id));
      expect(ranked.map((r: any) => [r.facility_id, r.rank, r.excluded_reason])).toEqual([
        [n.fac.centreA, null, 'NOT_ACCEPTING_HOLDS'], [n.fac.centreB, null, 'HOLD_TIMEOUT_NOT_CONFIGURED'],
      ]);
      // nothing selectable → no recommendation is stored
      expect((await select((await newRequest()).body.data.id)).body.data.recommendationId).toBeNull();
    } finally {
      await rows('update public.facilities set accepts_temporary_holds = true where id = $1', [n.fac.centreA]);
      await withPg((c) => setHoldTimeout(c, n.org.cbc, n.fac.centreB, 45));
    }
  });

  it('a source that stops sharing availability is not offered', async () => {
    await rows('update public.organizations set shares_network_availability = false where id = $1', [n.org.cbc]);
    try {
      expect((await select((await newRequest()).body.data.id)).body.data.ranked.map((r: any) => r.facility_id)).not.toContain(n.fac.centreB);
    } finally {
      await rows('update public.organizations set shares_network_availability = true where id = $1', [n.org.cbc]);
    }
  });

  it('a new selection replaces the pending one; another organization cannot select for this request', async () => {
    const { requestId, sel } = await pendingSelection();
    const again = (await select(requestId)).body.data;
    expect(again.recommendationId).not.toBe(sel.recommendationId);
    expect((await rows('select status::text as s from public.recommendations where id = $1', [sel.recommendationId]))[0].s).toBe('EXPIRED');
    expect((await select(requestId, n.user.drSharma)).status).toBe(403); // no EMERGENCY_STAFF role anywhere
  });

  it('is refused for a closed request or one past its deadline', async () => {
    const id = (await newRequest()).body.data.id;
    await rows("update public.requests set status = 'CANCELLED', cancelled_at = now() where id = $1", [id]);
    expect((await select(id)).body.error.code).toBe('REQUEST_NOT_OPEN');
    const late = (await newRequest()).body.data.id;
    await rows("update public.requests set required_by = now() - interval '1 minute' where id = $1", [late]);
    expect((await select(late)).body.error.code).toBe('REQUEST_DEADLINE_PASSED');
  });
});

describe('the human decision places a temporary hold — never a release', () => {
  it('approve: holds the whole need at the top-ranked source; the units stay reserved and unissued', async () => {
    const { requestId, sel } = await pendingSelection(4);
    const res = await decide(sel.recommendationId, { decision: 'APPROVE' });
    expect(res.status).toBe(200);
    expect(res.body.data.decision).toBe('APPROVED');
    const item = res.body.data.request.items[0];
    expect(res.body.data.request.status).toBe('ALLOCATED');
    expect(item).toMatchObject({ quantityRemaining: 0, holds: [{ source: { id: n.fac.centreA, name: expect.stringContaining('Centre A') }, status: 'RESERVED', quantity: 4, holdExpiresAt: expect.any(String) }] });

    const held = await heldUnits(requestId);
    expect(held).toHaveLength(4);
    for (const h of held) expect(h).toMatchObject({ allocation: 'RESERVED', unit: 'RESERVED', source_facility_id: n.fac.centreA });
    // hold length comes from the source's own parameter (30 minutes), not a default
    const minutes = (new Date(held[0].hold_expires_at).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);
    // no dispatch or issue has happened
    const ledger = await rows(`select count(*)::int n from public.transactions t join public.request_allocations a on a.inventory_unit_id = t.inventory_unit_id
      join public.request_items i on i.id = a.request_item_id where i.request_id = $1 and t.transaction_type in ('INVENTORY_DISPATCHED', 'INVENTORY_ISSUED')`, [requestId]);
    expect(ledger[0].n).toBe(0);
    // the response reveals no unit identifiers
    expect(JSON.stringify(res.body)).not.toMatch(/unit|EM-[0-9a-f]{8}/i);
    for (const h of held) expect(JSON.stringify(res.body)).not.toContain(h.allocation_id);

    const audit = await rows('select action, organization_id from public.audit_logs where entity_id = $1 order by action, organization_id', [requestId]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['allocation.hold_request', 'allocation.hold_create', 'request.create']));
    expect((await rows("select action from public.audit_logs where entity_id = $1 and action = 'recommendation.approve'", [sel.recommendationId]))).toHaveLength(1);
  });

  it('a decision cannot be repeated (409) and stock already held lowers what is offered next', async () => {
    const { sel } = await pendingSelection(2);
    expect((await decide(sel.recommendationId, { decision: 'APPROVE' })).status).toBe(200);
    const again = await decide(sel.recommendationId, { decision: 'APPROVE' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RECOMMENDATION_NOT_PENDING');
    // Centre A had 10 usable; 4 + 2 are now on hold, so 4 remain above (no reserve there)
    const next = (await select((await newRequest()).body.data.id)).body.data.ranked.find((r: any) => r.facility_id === n.fac.centreA);
    expect(next.spare_units_above_reserve).toBe(10 - 4 - 2);
  });

  it('modify: a lower quantity at a chosen source; the quantity can never exceed the need', async () => {
    const { requestId, sel } = await pendingSelection(4);
    expect((await decide(sel.recommendationId, { decision: 'MODIFY', modifiedQuantity: 2 })).status).toBe(400); // note required
    expect((await decide(sel.recommendationId, { decision: 'MODIFY', modifiedQuantity: 5, note: 'more' })).body.error.code).toBe('QUANTITY_EXCEEDS_NEED');
    expect((await decide(sel.recommendationId, { decision: 'MODIFY', modifiedQuantity: 2, note: 'x', sourceFacilityId: randomUUID() })).body.error.code).toBe('SOURCE_NOT_IN_SELECTION');
    const res = await decide(sel.recommendationId, { decision: 'MODIFY', modifiedQuantity: 2, sourceFacilityId: n.fac.centreB, note: 'closer to the ward' });
    expect(res.status).toBe(200);
    expect(res.body.data.request.items[0]).toMatchObject({ quantityRemaining: 2, holds: [{ source: { id: n.fac.centreB }, status: 'RESERVED', quantity: 2 }] });
    expect((await heldUnits(requestId)).every((h) => h.source_facility_id === n.fac.centreB)).toBe(true);
    // the rest can be selected again
    const rest = (await select(requestId)).body.data;
    expect(rest.quantityNeeded).toBe(2);
  });

  it('reject: reserves nothing', async () => {
    const { requestId, sel } = await pendingSelection();
    expect((await decide(sel.recommendationId, { decision: 'REJECT' })).status).toBe(400);
    const res = await decide(sel.recommendationId, { decision: 'REJECT', note: 'another arrangement' });
    expect(res.body.data.decision).toBe('REJECTED');
    expect(await heldUnits(requestId)).toHaveLength(0);
    expect((await get(`/api/emergency/requests/${requestId}`, sunrise())).body.data.status).toBe('OPEN');
  });

  it('re-checks stock and reserve at decision time: a source that can no longer supply is refused, nothing is held', async () => {
    const { requestId, sel } = await pendingSelection(4);
    // Centre A loses all but two of its usable units after the ranking was made
    const usable = await rows("select id from public.inventory_units where facility_id = $1 and status = 'AVAILABLE'", [n.fac.centreA]);
    for (const u of usable.slice(0, usable.length - 2)) await rows("select private.transition_unit_status($1::uuid, 'WASTED', null)", [u.id]);
    try {
      const res = await decide(sel.recommendationId, { decision: 'APPROVE' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SOURCE_NO_LONGER_AVAILABLE');
      expect(await heldUnits(requestId)).toHaveLength(0);
      // but the human may choose the other listed source instead
      expect((await decide(sel.recommendationId, { decision: 'APPROVE', sourceFacilityId: n.fac.centreB })).status).toBe(200);
      expect((await heldUnits(requestId)).every((h) => h.source_facility_id === n.fac.centreB)).toBe(true);
    } finally {
      await unit(n.fac.centreA, usable.length); // restock for the tests that follow
    }
  });

  it('only the requesting side can decide: other organizations get 404, blood-bank staff 403', async () => {
    const { sel } = await pendingSelection();
    expect((await decide(sel.recommendationId, { decision: 'APPROVE' }, n.user.drSharma)).status).toBe(403); // no EMERGENCY_STAFF role anywhere
    expect((await decide(sel.recommendationId, { decision: 'APPROVE' }, n.user.centreAAdmin)).status).toBe(403);
    expect((await decide(randomUUID(), { decision: 'APPROVE' })).status).toBe(404);
    expect((await decide('nope', { decision: 'APPROVE' })).status).toBe(400);
  });

  it('an expired selection cannot be decided', async () => {
    const { sel } = await pendingSelection();
    await rows("update public.recommendations set valid_until = now() - interval '1 minute' where id = $1", [sel.recommendationId]);
    const res = await decide(sel.recommendationId, { decision: 'APPROVE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECOMMENDATION_EXPIRED');
  });

  it('two simultaneous approvals: one wins, one hold set', async () => {
    const { requestId, sel } = await pendingSelection(3);
    const results = await Promise.all([decide(sel.recommendationId, { decision: 'APPROVE' }), decide(sel.recommendationId, { decision: 'APPROVE' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await heldUnits(requestId)).toHaveLength(3);
  });
});

describe('the source confirms or declines — the second human step', () => {
  let requestId: string;
  let allocations: string[];

  beforeAll(async () => {
    await unit(n.fac.centreA, 20); // earlier tests left the sources short
    await unit(n.fac.centreB, 20);
    const made = await pendingSelection(3);
    requestId = made.requestId;
    await decide(made.sel.recommendationId, { decision: 'APPROVE', sourceFacilityId: n.fac.centreA });
    allocations = (await heldUnits(requestId)).map((h) => h.allocation_id);
  });

  it('shows the source only the minimum delivery data', async () => {
    const res = await get(`/api/emergency/incoming?facilityId=${n.fac.centreA}`, n.user.centreAAdmin);
    expect(res.status).toBe(200);
    const mine = res.body.data.find((h: any) => h.allocationIds.some((id: string) => allocations.includes(id)));
    expect(mine).toEqual({
      sourceFacility: { id: n.fac.centreA, name: expect.stringContaining('Centre A') },
      requestNumber: expect.stringMatching(/^REQ-/), requestItemId: expect.any(String),
      destinationFacility: { id: n.fac.sunrise, name: expect.stringContaining('Sunrise') },
      bloodGroup: 'O-', component: 'PRBC', quantity: 3, urgency: 'CRITICAL', requiredBy: expect.any(String),
      status: 'RESERVED', holdExpiresAt: expect.any(String), allocationIds: expect.arrayContaining(allocations),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/patient|contact|phone|notes|requester|verified|EM-[0-9a-f]{8}|unit_code/i);
  });

  it('other sources and other roles see nothing of it', async () => {
    const other = await get('/api/emergency/incoming', n.user.centreBAdmin);
    expect(JSON.stringify(other.body)).not.toContain(allocations[0]);
    expect((await get(`/api/emergency/incoming?facilityId=${n.fac.centreA}`, n.user.centreBAdmin)).status).toBe(404);
    expect((await get('/api/emergency/incoming?facilityId=x', n.user.centreAAdmin)).status).toBe(400);
  });

  it('only blood-bank staff of the source can confirm; anyone else is refused and nothing changes', async () => {
    expect((await post('/api/emergency/holds/confirm', { allocationIds: allocations }, n.user.centreBAdmin)).status).toBe(404);
    expect((await post('/api/emergency/holds/confirm', { allocationIds: [randomUUID()] }, n.user.centreAAdmin)).status).toBe(404);
    expect((await post('/api/emergency/holds/confirm', { allocationIds: [] }, n.user.centreAAdmin)).status).toBe(400);
    expect((await heldUnits(requestId)).every((h) => h.allocation === 'RESERVED')).toBe(true);
  });

  it('confirm: the hold becomes CONFIRMED; the units stay reserved — nothing is dispatched or issued', async () => {
    const res = await post('/api/emergency/holds/confirm', { allocationIds: allocations }, n.user.centreAAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ confirmed: 3 });
    for (const h of await heldUnits(requestId)) expect(h).toMatchObject({ allocation: 'CONFIRMED', unit: 'RESERVED' });
    const view = (await get(`/api/emergency/requests/${requestId}`, sunrise())).body.data;
    expect(view.items[0].holds).toEqual([{ source: expect.objectContaining({ id: n.fac.centreA }), status: 'CONFIRMED', quantity: 3, holdExpiresAt: null }]);
    expect(view.status).toBe('ALLOCATED');
    const issued = await rows(`select count(*)::int n from public.transactions t join public.request_allocations a on a.inventory_unit_id = t.inventory_unit_id
      where a.id = any($1::uuid[]) and t.transaction_type in ('INVENTORY_DISPATCHED', 'INVENTORY_ISSUED')`, [allocations]);
    expect(issued[0].n).toBe(0);
    expect((await post('/api/emergency/holds/confirm', { allocationIds: allocations }, n.user.centreAAdmin)).status).toBe(409); // already confirmed
    expect((await get('/api/emergency/incoming', n.user.centreAAdmin)).body.data.find((h: any) => h.allocationIds.includes(allocations[0])).status).toBe('CONFIRMED');
  });

  it('decline: units return to stock; the requester learns only the code, never the source’s text', async () => {
    const made = await pendingSelection(2);
    await decide(made.sel.recommendationId, { decision: 'APPROVE', sourceFacilityId: n.fac.centreB });
    const held = await heldUnits(made.requestId);
    const secret = 'ZX-SOURCE-PRIVATE we keep these for a surgical list';
    const res = await post('/api/emergency/holds/decline', { allocationIds: held.map((h) => h.allocation_id), note: secret }, n.user.centreBAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ declined: 2 });
    for (const h of await heldUnits(made.requestId)) expect(h).toMatchObject({ allocation: 'CANCELLED', unit: 'AVAILABLE' });
    const view = await get(`/api/emergency/requests/${made.requestId}`, sunrise());
    expect(JSON.stringify(view.body)).not.toContain('ZX-SOURCE-PRIVATE');
    expect(view.body.data.items[0]).toMatchObject({ quantityRemaining: 2, holds: [] });
    // the requesting organization's audit rows carry the structured code and no free text
    const requesterAudit = await rows("select new_value from public.audit_logs where entity_id = $1 and organization_id = $2 and action = 'allocation.decline'", [made.requestId, n.org.sunrise]);
    expect(requesterAudit).toHaveLength(2); // one per allocation
    expect(JSON.stringify(requesterAudit)).not.toContain('ZX-SOURCE-PRIVATE');
    for (const a of requesterAudit) expect(a.new_value.reason_code).toBe('SOURCE_DECLINED');
    expect((await post('/api/emergency/holds/decline', { allocationIds: held.map((h) => h.allocation_id) }, n.user.centreBAdmin)).status).toBe(400); // a note is required
  });

  it('a hold that has expired cannot be confirmed (409); the database releases it', async () => {
    const made = await pendingSelection(1);
    await decide(made.sel.recommendationId, { decision: 'APPROVE', sourceFacilityId: n.fac.centreA });
    const held = await heldUnits(made.requestId);
    await withPg(async (c) => {
      await c.query("select set_config('bloodlink.allocation_write', 'on', false)");
      await c.query("update public.request_allocations set hold_expires_at = now() - interval '1 minute' where id = $1", [held[0].allocation_id]);
      await c.query("select set_config('bloodlink.allocation_write', '', false)");
    });
    const res = await post('/api/emergency/holds/confirm', { allocationIds: [held[0].allocation_id] }, n.user.centreAAdmin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
    expect((await heldUnits(made.requestId))[0].allocation).toBe('RESERVED'); // untouched until the timeout job releases it
  });

  it('holds of different sources cannot be mixed in one call', async () => {
    const a = await pendingSelection(1);
    await decide(a.sel.recommendationId, { decision: 'APPROVE', sourceFacilityId: n.fac.centreA });
    const b = await pendingSelection(1);
    await decide(b.sel.recommendationId, { decision: 'APPROVE', sourceFacilityId: n.fac.centreB });
    const ids = [...(await heldUnits(a.requestId)), ...(await heldUnits(b.requestId))].map((h) => h.allocation_id);
    expect((await post('/api/emergency/holds/confirm', { allocationIds: ids }, n.user.centreAAdmin)).status).toBe(400);
    void staffB;
  });
});

describe('nothing is ever released automatically', () => {
  it('no emergency endpoint dispatches, issues or returns units', async () => {
    const before = await rows("select count(*)::int n from public.transactions where transaction_type in ('INVENTORY_DISPATCHED', 'INVENTORY_ISSUED', 'INVENTORY_RETURNED') and note like 'temporary hold%'");
    expect(before[0].n).toBe(0);
    for (const path of ['dispatch', 'issue', 'return', 'release']) {
      expect((await post(`/api/emergency/holds/${path}`, { allocationIds: [randomUUID()] }, n.user.centreAAdmin)).status).toBe(404);
    }
  });
});
