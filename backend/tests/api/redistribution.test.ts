import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haversineKm } from '../../src/intelligence/redistribution.js';
import type { Network } from '../db/fixtures.js';
import { buildApp, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork, withPg } from './harness.js';

/**
 * Destination: Centre A (ABC organization) is short of O− PRBC.  Source: Centre B (City Blood Centre) has plenty.
 * The two are different organizations, so this exercises the cross-organization privacy rules.
 */
const db = realDatabase();
const app = buildApp({ db });
let n: Network;
let manager: string;
let staff: string;
let superAdmin: string;
let etaMinutes: number;

const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (path: string, userId?: string) => (userId ? request(app).get(path).set(as(userId)) : request(app).get(path));
const post = (path: string, body: unknown, userId?: string) =>
  userId ? request(app).post(path).set(as(userId)).send(body as object) : request(app).post(path).send(body as object);
const rows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);

async function unit(facilityId: string, group: 'O-' | 'A+', count = 1) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push((await rows(
      `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '60 days', now() + interval '30 days', 'INVENTORY_ADDED', 'AVAILABLE', null) as id`,
      [`RD-${randomUUID()}`, facilityId, n.comp.PRBC, n.bg[group]]))[0].id);
  }
  return ids;
}
const issue = (id: string) => rows("select private.transition_unit_status($1::uuid, 'ISSUED', null)", [id]);
const param = (key: string, value: unknown, org: string) =>
  rows(`insert into public.planning_parameters (key, organization_id, value, description) values ($1, $2, $3::jsonb, 'redistribution api test')`, [key, org, JSON.stringify(value)]);

const runIntelligence = (userId: string, facilityId: string) => post('/api/intelligence/runs', { facilityId }, userId);
const runRedistribution = (userId = n.user.centreAAdmin, facilityId = n.fac.centreA) => post('/api/intelligence/redistribution/runs', { facilityId }, userId);
const recs = async (query = '', userId = n.user.centreAAdmin) => (await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreA}&type=REDISTRIBUTION${query}`, userId)).body;
const pending = async () => (await recs('&status=PENDING')).data[0];
const decide = (id: string, body: unknown, userId = n.user.centreAAdmin) => post(`/api/intelligence/recommendations/${id}/decision`, body, userId);
/** A fresh PENDING redistribution recommendation (re-running expires the previous one). */
async function freshRecommendation() {
  const res = await runRedistribution();
  expect(res.status).toBe(201);
  return pending();
}

beforeAll(async () => {
  n = await seedNetwork();
  manager = await createUser('RdManager', n.org.abc, n.fac.centreA);
  await grantRole(manager, 'INVENTORY_MANAGER', n.org.abc, n.fac.centreA);
  staff = await createUser('RdStaff', n.org.abc, n.fac.centreA);
  await grantRole(staff, 'BLOOD_BANK_STAFF', n.org.abc, n.fac.centreA);
  superAdmin = await createUser('RdSuper', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);

  // Destination Centre A, O− PRBC: 1 usable, 3 issued in the window → demand 0.3/day, cover 3.33 days.
  await unit(n.fac.centreA, 'O-');
  for (const id of await unit(n.fac.centreA, 'O-', 3)) await issue(id);
  // Source Centre B, O− PRBC: 20 usable, 5 issued → demand 0.5/day.
  await unit(n.fac.centreB, 'O-', 20);
  for (const id of await unit(n.fac.centreB, 'O-', 5)) await issue(id);

  for (const org of [n.org.abc, n.org.cbc]) {
    await param('forecast.history_days', 10, org);
    await param('forecast.horizon_days', 14, org);
  }
  await param('coverage.target_days', 30, n.org.abc);
  await param('coverage.risk_bands', { criticalBelowDays: 5, highBelowDays: 10, mediumBelowDays: 25 }, n.org.abc);

  const [{ km }] = [{ km: haversineKm(26.85, 80.95, 26.9, 81.02) }];
  etaMinutes = Math.ceil(((km * 1.3) / 40) * 60);
});

afterAll(async () => {
  await rows("delete from public.planning_parameters where description = 'redistribution api test'");
  await rows('update public.organizations set shares_network_availability = true where id = $1', [n.org.cbc]);
  await db.disconnect();
});

describe('access control', () => {
  it('requires authentication', async () => {
    expect((await post('/api/intelligence/redistribution/runs', { facilityId: n.fac.centreA })).status).toBe(401);
    expect((await get('/api/transfers')).status).toBe(401);
    expect((await post(`/api/transfers/${randomUUID()}/approve`, {})).status).toBe(401);
  });

  it('roles without inventory access are forbidden on every new endpoint', async () => {
    for (const userId of [n.user.drSharma, n.user.publicUser, n.user.donorUser, n.user.sunriseStaff, superAdmin]) {
      expect((await runRedistribution(userId)).status).toBe(403);
      expect((await get('/api/transfers', userId)).status).toBe(403);
      expect((await post(`/api/transfers/${randomUUID()}/approve`, {}, userId)).status).toBe(403);
      expect((await post(`/api/transfers/${randomUUID()}/reject`, { reasonCode: 'OTHER' }, userId)).status).toBe(403);
    }
  });

  it('read-only staff cannot run; managers can run but not decide', async () => {
    expect((await runRedistribution(staff)).status).toBe(403);
    expect((await runRedistribution(manager)).status).toBe(201);
    expect((await decide(randomUUID(), { decision: 'APPROVE' }, manager)).status).toBe(403);
  });

  it('another organization cannot run against this facility (404) and a facility without stock is 422', async () => {
    expect((await runRedistribution(n.user.centreBAdmin, n.fac.centreA)).status).toBe(404);
    expect((await runRedistribution(n.user.abcOrgAdmin, n.fac.abcHospital)).status).toBe(422);
    expect((await post('/api/intelligence/redistribution/runs', { facilityId: 'x' }, n.user.centreAAdmin)).status).toBe(400);
  });
});

describe('recommending a redistribution', () => {
  it('needs the destination’s own shortage prediction first: nothing is recommended without one', async () => {
    const res = await runRedistribution();
    expect(res.body.data).toMatchObject({ basedOnPredictions: 0, redistributionRecommendations: [], notRecommended: [] });
  });

  it('skips with a reason while the transfer limits are not configured', async () => {
    await runIntelligence(n.user.centreBAdmin, n.fac.centreB);
    expect((await runIntelligence(n.user.centreAAdmin, n.fac.centreA)).status).toBe(201);
    const res = await runRedistribution();
    expect(res.body.data.basedOnPredictions).toBeGreaterThanOrEqual(1);
    expect(res.body.data.redistributionRecommendations).toEqual([]);
    expect(res.body.data.notRecommended).toEqual([{ reason: 'TRANSFER_LIMITS_NOT_CONFIGURED', count: expect.any(Number) }]);
  });

  it('finds no source while no source has a reserve floor configured (no default is assumed)', async () => {
    await param('transfer.min_units', 2, n.org.abc);
    await param('transfer.max_units', 6, n.org.abc);
    const res = await runRedistribution();
    expect(res.body.data.redistributionRecommendations).toEqual([]);
    expect(res.body.data.notRecommended).toEqual(expect.arrayContaining([{ reason: 'NO_SOURCE_AVAILABLE', count: expect.any(Number) }]));
  });

  it('recommends the source and quantity from the documented rule once everything is configured', async () => {
    await param('reserve.floor_days', 10, n.org.cbc);
    await param('eta.road_factor', 1.3, n.org.abc);
    await param('eta.urban_speed_kmh', 40, n.org.abc);
    const res = await runRedistribution();
    expect(res.status).toBe(201);
    // deficit = ceil(30 × 0.3 − (1 + 0)) = 8; source spare = 20 − 0 − ceil(10 × 0.5) = 15; max_units 6 → 6
    expect(res.body.data.redistributionRecommendations).toEqual([
      { id: expect.any(String), bloodGroup: 'O-', component: 'PRBC', quantity: 6, priority: 'CRITICAL', source: { id: n.fac.centreB, name: expect.stringContaining('Centre B') } },
    ]);
    expect(res.body.data.model).toMatchObject({ name: 'trailing-average-baseline', kind: 'RULE_BASED' });
    expect(res.body.data.notRecommended.some((r: any) => r.reason === 'NO_SOURCE_AVAILABLE')).toBe(false);
  });

  it('stores the approved payload shape and a reproducible explanation, awaiting a human', async () => {
    const rec = await pending();
    expect(rec).toMatchObject({
      type: 'REDISTRIBUTION', status: 'PENDING', priority: 'CRITICAL', source: 'SYSTEM_RULE', modelVersion: 'trailing-average-baseline@1',
      facilityId: n.fac.centreA, decidedBy: null, modifiedPayload: null,
    });
    expect(rec.payload).toEqual({
      source_facility_id: n.fac.centreB,
      destination_facility_id: n.fac.centreA,
      blood_group_id: n.bg['O-'],
      component_id: n.comp.PRBC,
      quantity: 6,
      destination_cover_before_days: 3.33,
      destination_cover_after_days: 23.33, // (1 + 6) / 0.3
      destination_prediction_id: rec.relatedPredictionId,
      source_prediction_id: expect.any(String),
      source_can_fulfil: true, // 15 ≥ 8
      source_spare_units: 15,
      near_expiry_opportunity: null,
      eta_minutes: etaMinutes,
      parameters_used: { 'coverage.target_days': 30, 'transfer.min_units': 2, 'transfer.max_units': 6, 'eta.road_factor': 1.3, 'eta.urban_speed_kmh': 40 },
    });
    expect(rec.explanation.data).toMatchObject({ destination: { deficit: 8, target_days: 30 }, shared_source_outputs: { source_spare_units: 15, source_can_fulfil: true } });
    expect(rec.explanation.action).toMatch(/source facility must still approve/);
    const [prediction] = await rows('select prediction_type::text as t, facility_id from public.predictions where id = $1', [rec.relatedPredictionId]);
    expect(prediction).toEqual({ t: 'SHORTAGE', facility_id: n.fac.centreA });
  });

  it('PRIVACY: the recommendation exposes no source demand, reserve, cover, stock or expiry information', async () => {
    const rec = await pending();
    const text = JSON.stringify(rec);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); }
    };
    walk(rec);
    for (const key of keys) expect(key, key).not.toMatch(/floor|reserve|source_demand|source_cover|source_usable|expiry_date|unit_code|source_stock/i);
    // only these source-side facts are shared: identity, can-fulfil, spare units, ETA
    expect(Object.keys(rec.payload).filter((k) => k.startsWith('source_')).sort()).toEqual(
      ['source_can_fulfil', 'source_facility_id', 'source_prediction_id', 'source_spare_units'],
    );
    // the source's own figures (20 usable, demand 0.5) appear nowhere
    expect(text).not.toContain('"usable_units":20');
    expect(text).not.toContain('0.5');
    // the source organization sees neither the recommendation nor the destination's predictions
    expect((await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreB}&type=REDISTRIBUTION`, n.user.centreBAdmin)).body.data).toEqual([]);
    expect((await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreA}`, n.user.centreBAdmin)).status).toBe(404);
  });

  it('a source that stops sharing availability is not offered', async () => {
    await rows('update public.organizations set shares_network_availability = false where id = $1', [n.org.cbc]);
    const res = await runRedistribution();
    expect(res.body.data.redistributionRecommendations).toEqual([]);
    await rows('update public.organizations set shares_network_availability = true where id = $1', [n.org.cbc]);
    expect((await runRedistribution()).body.data.redistributionRecommendations).toHaveLength(1);
  });

  it('re-running expires the previous pending recommendation and keeps exactly one pending', async () => {
    const before = await pending();
    const res = await runRedistribution();
    expect(res.body.data.redistributionRecommendationsExpired).toBe(1);
    const after = await recs('&status=PENDING');
    expect(after.data).toHaveLength(1);
    expect(after.data[0].id).not.toBe(before.id);
    expect((await recs(`&status=EXPIRED`)).data.map((r: any) => r.id)).toContain(before.id);
  });

  it('audits every run, and changes no inventory, ledger, transfer or allocation', async () => {
    const snapshot = () => rows(
      `select (select count(*) from public.inventory_units)::int u, (select count(*) from public.transactions)::int t,
              (select count(*) from public.transfers)::int tr, (select count(*) from public.request_allocations)::int a`);
    const before = await snapshot();
    const res = await runRedistribution();
    expect(await snapshot()).toEqual(before);
    const [entry] = await rows("select user_id, organization_id, facility_id, new_value from public.audit_logs where action = 'redistribution.generate' and entity_id = $1", [res.body.data.runId]);
    expect(entry).toMatchObject({ user_id: n.user.centreAAdmin, organization_id: n.org.abc, facility_id: n.fac.centreA, new_value: { recommendations_created: 1 } });
  });

  it('two simultaneous runs are serialised and leave one pending recommendation', async () => {
    const [a, b] = await Promise.all([runRedistribution(), runRedistribution(n.user.abcOrgAdmin)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await recs('&status=PENDING')).data).toHaveLength(1);
  });

  it('lists both recommendation types unless filtered', async () => {
    await runIntelligence(n.user.centreAAdmin, n.fac.centreA); // also creates procurement recommendations
    await runRedistribution();
    const all = (await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreA}&status=PENDING&pageSize=100`, n.user.centreAAdmin)).body.data;
    expect(new Set(all.map((r: any) => r.type))).toEqual(new Set(['PROCUREMENT', 'REDISTRIBUTION']));
    expect((await get(`/api/intelligence/recommendations?type=NOPE`, n.user.centreAAdmin)).status).toBe(400);
  });
});

describe('deciding a redistribution recommendation', () => {
  it('cannot raise the quantity above the recommendation (422)', async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 7, note: 'more' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('QUANTITY_ABOVE_RECOMMENDATION');
    expect((await pending()).status).toBe('PENDING');
    expect(await rows('select id from public.transfers where recommendation_id = $1', [rec.id])).toHaveLength(0);
  });

  it('modify (lower): proposes a transfer of the lowered quantity, records the decision and audits both organizations', async () => {
    const rec = await pending();
    const res = await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 4, note: 'partial for now' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'MODIFIED', decidedBy: n.user.centreAAdmin, transferId: expect.any(String) });
    expect(res.body.data.modifiedPayload).toMatchObject({ quantity: 4, source_facility_id: n.fac.centreB });
    expect(res.body.data.payload.quantity).toBe(6);

    const [t] = await rows('select * from public.transfers where id = $1', [res.body.data.transferId]);
    expect(t).toMatchObject({
      status: 'PROPOSED', source_facility_id: n.fac.centreB, destination_facility_id: n.fac.centreA, blood_group_id: n.bg['O-'],
      component_id: n.comp.PRBC, requested_quantity: 4, recommendation_id: rec.id, initiated_by: n.user.centreAAdmin,
      estimated_transit_minutes: etaMinutes, approved_quantity: null, reason: 'Redistribution recommendation',
    });
    expect((await rows('select count(*)::int n from public.transfer_items where transfer_id = $1', [t.id]))[0].n).toBe(0); // no unit is touched yet

    const audit = await rows('select action, organization_id, facility_id from public.audit_logs where entity_id = $1 order by action, organization_id', [t.id]);
    expect(audit.map((a) => a.action)).toEqual(['transfer.propose', 'transfer.propose']);
    expect(new Set(audit.map((a) => a.organization_id))).toEqual(new Set([n.org.abc, n.org.cbc]));
    const decisionAudit = await rows("select new_value from public.audit_logs where entity_id = $1 and action = 'recommendation.modify'", [rec.id]);
    expect(decisionAudit[0].new_value).toMatchObject({ status: 'MODIFIED', quantity: 4, transfer_id: t.id });
    expect(JSON.stringify(decisionAudit)).not.toContain('partial for now');
  });

  it('reject: records the decision and creates no transfer', async () => {
    const rec = await freshRecommendation();
    expect((await decide(rec.id, { decision: 'REJECT' })).status).toBe(400); // a note is required
    const res = await decide(rec.id, { decision: 'REJECT', note: 'handled another way' });
    expect(res.body.data).toMatchObject({ status: 'REJECTED', transferId: null });
    expect(await rows('select id from public.transfers where recommendation_id = $1', [rec.id])).toHaveLength(0);
  });

  it('approve: proposes a transfer of the full recommended quantity; it cannot be decided twice', async () => {
    const rec = await freshRecommendation();
    const res = await decide(rec.id, { decision: 'APPROVE' }, n.user.abcOrgAdmin);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', decidedBy: n.user.abcOrgAdmin, transferId: expect.any(String) });
    const [t] = await rows('select requested_quantity, initiated_by from public.transfers where id = $1', [res.body.data.transferId]);
    expect(t).toEqual({ requested_quantity: 6, initiated_by: n.user.abcOrgAdmin });
    expect((await decide(rec.id, { decision: 'APPROVE' })).status).toBe(409);
    expect(await rows('select id from public.transfers where recommendation_id = $1', [rec.id])).toHaveLength(1);
  });

  it('is refused (and rolled back) when the source is no longer available', async () => {
    const rec = await freshRecommendation();
    await rows('update public.organizations set shares_network_availability = false where id = $1', [n.org.cbc]);
    const res = await decide(rec.id, { decision: 'APPROVE' });
    await rows('update public.organizations set shares_network_availability = true where id = $1', [n.org.cbc]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOURCE_NO_LONGER_AVAILABLE');
    expect((await pending()).status).toBe('PENDING');
    expect(await rows('select id from public.transfers where recommendation_id = $1', [rec.id])).toHaveLength(0);
  });

  it('is denied to readers without a deciding role and hidden from other organizations', async () => {
    const rec = await pending();
    expect((await decide(rec.id, { decision: 'APPROVE' }, staff)).status).toBe(403);
    expect((await decide(rec.id, { decision: 'APPROVE' }, n.user.centreBAdmin)).status).toBe(404); // a BLOOD_BANK_ADMIN elsewhere: the facility is hidden
  });
});

describe('the source’s approval of the proposed transfer', () => {
  let transferId: string;
  let secondTransferId: string;

  beforeAll(async () => {
    for (const target of ['first', 'second'] as const) {
      const rec = await freshRecommendation();
      const res = await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 3, note: `proposal ${target}` });
      if (target === 'first') transferId = res.body.data.transferId;
      else secondTransferId = res.body.data.transferId;
    }
  });

  it('both sides see the transfer with the same minimal fields, and nobody else does', async () => {
    const fromSource = await get(`/api/transfers/${transferId}`, n.user.centreBAdmin);
    const fromDestination = await get(`/api/transfers/${transferId}`, n.user.centreAAdmin);
    expect(fromSource.status).toBe(200);
    expect(fromDestination.body).toEqual(fromSource.body);
    expect(fromSource.body.data).toEqual({
      id: transferId, transferNumber: expect.stringMatching(/^TRF-\d{4}-\d{6}$/), status: 'PROPOSED',
      source: { id: n.fac.centreB, name: expect.stringContaining('Centre B') }, destination: { id: n.fac.centreA, name: expect.stringContaining('Centre A') },
      bloodGroup: 'O-', component: 'PRBC', requestedQuantity: 3, approvedQuantity: null, recommendationId: expect.any(String),
      estimatedTransitMinutes: etaMinutes, rejectionReason: null, requestedAt: expect.any(String), approvedAt: null, dispatchedAt: null, receivedAt: null, cancelledAt: null,
    });
    expect(JSON.stringify(fromSource.body)).not.toMatch(/unit|expiry|usable|demand|reserve/i);
    expect((await get(`/api/transfers/${randomUUID()}`, n.user.centreAAdmin)).status).toBe(404);
    expect((await get('/api/transfers/not-a-uuid', n.user.centreAAdmin)).status).toBe(400);
  });

  it('lists transfers for either side, filterable by status and paginated', async () => {
    const source = await get('/api/transfers?status=PROPOSED&pageSize=100', n.user.centreBAdmin);
    const destination = await get('/api/transfers?status=PROPOSED&pageSize=100', n.user.centreAAdmin);
    expect(source.body.data.map((t: any) => t.id)).toEqual(expect.arrayContaining([transferId, secondTransferId]));
    expect(destination.body.pagination.total).toBe(source.body.pagination.total);
    expect((await get('/api/transfers?status=NOPE', n.user.centreAAdmin)).status).toBe(400);
    expect((await get(`/api/transfers?facilityId=${n.fac.centreB}`, n.user.centreAAdmin)).status).toBe(404);
  });

  it('only the source BLOOD_BANK_ADMIN can approve or reject: the destination and other roles are refused', async () => {
    for (const userId of [n.user.centreAAdmin, n.user.abcOrgAdmin, manager, staff, n.user.centreBStaff]) {
      expect((await post(`/api/transfers/${transferId}/approve`, {}, userId)).status, 'approve').toBe(403);
      expect((await post(`/api/transfers/${transferId}/reject`, { reasonCode: 'OTHER' }, userId)).status, 'reject').toBe(403);
    }
    expect((await get(`/api/transfers/${transferId}`, n.user.centreAAdmin)).body.data.status).toBe('PROPOSED');
  });

  it('approve: the database reserves first-expiry-first units at the source and audits both organizations', async () => {
    const res = await post(`/api/transfers/${transferId}/approve`, {}, n.user.centreBAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: transferId, status: 'APPROVED', requestedQuantity: 3, approvedQuantity: 3, approvedAt: expect.any(String) });
    const reserved = await rows(`select u.status::text as s, u.facility_id from public.transfer_items ti join public.inventory_units u on u.id = ti.inventory_unit_id where ti.transfer_id = $1`, [transferId]);
    expect(reserved).toHaveLength(3);
    for (const r of reserved) expect(r).toEqual({ s: 'RESERVED', facility_id: n.fac.centreB });
    const audit = await rows("select organization_id, user_id from public.audit_logs where entity_id = $1 and action = 'transfer.approve'", [transferId]);
    expect(audit).toHaveLength(2);
    for (const a of audit) expect(a.user_id).toBe(n.user.centreBAdmin);
    expect(new Set(audit.map((a) => a.organization_id))).toEqual(new Set([n.org.abc, n.org.cbc]));
  });

  it('a transfer cannot be approved or rejected twice (409)', async () => {
    const again = await post(`/api/transfers/${transferId}/approve`, {}, n.user.centreBAdmin);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('STATE_CONFLICT');
    expect((await post(`/api/transfers/${transferId}/reject`, { reasonCode: 'OTHER' }, n.user.centreBAdmin)).status).toBe(409);
  });

  it('rejection reasons are a fixed code; free text is not accepted as the reason', async () => {
    for (const body of [{}, { reasonCode: 'Patient Ravi needs it' }, { reason: 'free text' }, { reasonCode: 'OTHER', reason: 'free text' }, { reasonCode: 'OTHER', note: '' }, { reasonCode: 'OTHER', note: 'x'.repeat(1001) }, { reasonCode: 'OTHER', extra: 1 }]) {
      expect((await post(`/api/transfers/${secondTransferId}/reject`, body, n.user.centreBAdmin)).status).toBe(400);
    }
    const res = await post(`/api/transfers/${secondTransferId}/reject`, { reasonCode: 'RESERVE_REQUIRED' }, n.user.centreBAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'REJECTED', rejectionReason: 'RESERVE_REQUIRED' });
    // the destination sees the code; the audit rows carry the code and nothing else
    expect((await get(`/api/transfers/${secondTransferId}`, n.user.centreAAdmin)).body.data.rejectionReason).toBe('RESERVE_REQUIRED');
    const audit = await rows("select new_value from public.audit_logs where entity_id = $1 and action = 'transfer.reject'", [secondTransferId]);
    expect(audit).toHaveLength(2);
    for (const a of audit) expect(a.new_value).toEqual({ status: 'REJECTED', reason: 'RESERVE_REQUIRED' });
    const units = await rows('select count(*)::int n from public.transfer_items where transfer_id = $1', [secondTransferId]);
    expect(units[0].n).toBe(0);
  });

  it('approving more than was requested is refused', async () => {
    const rec = await freshRecommendation();
    const proposed = (await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 2, note: 'small' })).body.data.transferId;
    expect((await post(`/api/transfers/${proposed}/approve`, { approvedQuantity: 3 }, n.user.centreBAdmin)).status).toBe(422);
    expect((await post(`/api/transfers/${proposed}/approve`, { approvedQuantity: 0 }, n.user.centreBAdmin)).status).toBe(400);
    expect((await post(`/api/transfers/${proposed}/approve`, { approvedQuantity: 1 }, n.user.centreBAdmin)).body.data).toMatchObject({ status: 'APPROVED', approvedQuantity: 1 });
  });

  it('a source that no longer has the units cannot approve (409 INSUFFICIENT_UNITS) and nothing changes', async () => {
    const rec = await freshRecommendation();
    const proposed = (await decide(rec.id, { decision: 'APPROVE' })).body.data.transferId; // 6 units requested
    // Centre B keeps only a few usable units
    const [{ n: usable }] = await rows("select count(*)::int n from public.inventory_units where facility_id = $1 and status = 'AVAILABLE' and blood_group_id = $2 and component_id = $3", [n.fac.centreB, n.bg['O-'], n.comp.PRBC]);
    for (const u of (await rows("select id from public.inventory_units where facility_id = $1 and status = 'AVAILABLE' and blood_group_id = $2 and component_id = $3 limit $4", [n.fac.centreB, n.bg['O-'], n.comp.PRBC, usable - 2]))) {
      await rows("select private.transition_unit_status($1::uuid, 'WASTED', null)", [u.id]);
    }
    const res = await post(`/api/transfers/${proposed}/approve`, {}, n.user.centreBAdmin);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_UNITS');
    expect((await get(`/api/transfers/${proposed}`, n.user.centreAAdmin)).body.data.status).toBe('PROPOSED');
    expect((await rows('select count(*)::int n from public.transfer_items where transfer_id = $1', [proposed]))[0].n).toBe(0);
  });

  it('PRIVACY: the source free-text note stays in the source organization; the destination receives only the fixed code', async () => {
    const secret = 'ZX-PRIVATE-NOTE we keep this reserve for the trauma centre';
    await unit(n.fac.centreB, 'O-', 20); // the previous test used up the source's stock
    const rec = await freshRecommendation();
    const proposed = (await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 2, note: 'destination note' })).body.data.transferId;

    const res = await post(`/api/transfers/${proposed}/reject`, { reasonCode: 'RESERVE_REQUIRED', note: secret }, n.user.centreBAdmin);
    expect(res.status).toBe(200);

    // 1. No API view of the transfer contains the note; both sides see the same thing, carrying only the code.
    const fromSource = await get(`/api/transfers/${proposed}`, n.user.centreBAdmin);
    const fromDestination = await get(`/api/transfers/${proposed}`, n.user.centreAAdmin);
    for (const body of [res.body, fromSource.body, fromDestination.body]) {
      expect(JSON.stringify(body)).not.toContain('ZX-PRIVATE-NOTE');
      expect(body.data.rejectionReason).toBe('RESERVE_REQUIRED');
    }
    expect(fromDestination.body).toEqual(fromSource.body);

    // 2. The transfer row the destination can read holds the code only.
    expect((await rows('select rejection_reason from public.transfers where id = $1', [proposed]))[0].rejection_reason).toBe('RESERVE_REQUIRED');

    // 3. The destination organization's audit rows carry the code and no free text anywhere.
    const destinationAudit = await rows('select action, new_value from public.audit_logs where entity_id = $1 and organization_id = $2', [proposed, n.org.abc]);
    expect(destinationAudit.map((a) => a.action).sort()).toEqual(['transfer.propose', 'transfer.reject']);
    expect(JSON.stringify(destinationAudit)).not.toContain('ZX-PRIVATE-NOTE');
    expect(destinationAudit.find((a) => a.action === 'transfer.reject')!.new_value).toEqual({ status: 'REJECTED', reason: 'RESERVE_REQUIRED' });

    // 4. The note exists exactly once: in the source organization's audit log, tied to the rejecting user.
    const carrying = await rows('select organization_id, user_id, action, new_value from public.audit_logs where new_value::text like $1', ['%ZX-PRIVATE-NOTE%']);
    expect(carrying).toEqual([{ organization_id: n.org.cbc, user_id: n.user.centreBAdmin, action: 'transfer.reject_note', new_value: { note: secret } }]);

    // 5. Nothing else the destination can read carries it (transfers, recommendations).
    const anywhere = await rows(
      `select (select count(*) from public.transfers where reason like $1 or rejection_reason like $1)::int as transfers,
              (select count(*) from public.recommendations where decision_note like $1 or payload::text like $1 or data_explanation::text like $1)::int as recommendations`,
      ['%ZX-PRIVATE-NOTE%']);
    expect(anywhere[0]).toEqual({ transfers: 0, recommendations: 0 });
  });

  it('a rejection without a note writes no note row', async () => {
    await unit(n.fac.centreB, 'O-', 20); // the previous test used up the source's stock
    const rec = await freshRecommendation();
    const proposed = (await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 2, note: 'again' })).body.data.transferId;
    expect((await post(`/api/transfers/${proposed}/reject`, { reasonCode: 'NOT_NEEDED' }, n.user.centreBAdmin)).status).toBe(200);
    expect(await rows("select id from public.audit_logs where entity_id = $1 and action = 'transfer.reject_note'", [proposed])).toHaveLength(0);
  });

  it('a note on a rejection that fails (destination user, wrong state) is never written', async () => {
    await unit(n.fac.centreB, 'O-', 20); // the previous test used up the source's stock
    const rec = await freshRecommendation();
    const proposed = (await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 2, note: 'third' })).body.data.transferId;
    expect((await post(`/api/transfers/${proposed}/reject`, { reasonCode: 'OTHER', note: 'ZX-NOT-WRITTEN' }, n.user.centreAAdmin)).status).toBe(403);
    expect((await post(`/api/transfers/${transferId}/reject`, { reasonCode: 'OTHER', note: 'ZX-NOT-WRITTEN' }, n.user.centreBAdmin)).status).toBe(409); // already approved
    expect(await rows("select id from public.audit_logs where new_value::text like '%ZX-NOT-WRITTEN%'")).toHaveLength(0);
  });
});
