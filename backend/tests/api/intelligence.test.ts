import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Network } from '../db/fixtures.js';
import { buildApp, tokenFor } from '../support/testApp.js';
import { createUser, grantRole, realDatabase, seedNetwork, withPg } from './harness.js';

const db = realDatabase();
const app = buildApp({ db });
let n: Network;
let manager: string; // INVENTORY_MANAGER at Centre A: may run, may not decide
let staff: string; // BLOOD_BANK_STAFF at Centre A: may read only
let superAdmin: string;

const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (path: string, userId?: string) => (userId ? request(app).get(path).set(as(userId)) : request(app).get(path));
const post = (path: string, body: unknown, userId?: string) => (userId ? request(app).post(path).set(as(userId)).send(body as object) : request(app).post(path).send(body as object));

async function unit(facilityId: string, group: 'O-' | 'A+', status: 'AVAILABLE' | 'QUARANTINED' = 'AVAILABLE') {
  return withPg(async (c) =>
    (await c.query(
      `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '60 days', now() + interval '30 days', 'INVENTORY_ADDED', $5, null) as id`,
      [`INT-${randomUUID()}`, facilityId, n.comp.PRBC, n.bg[group], status])).rows[0].id as string);
}
const issue = (unitId: string) => withPg((c) => c.query("select private.transition_unit_status($1::uuid, 'ISSUED', null)", [unitId]));
const param = (key: string, value: unknown, org = n.org.abc) =>
  withPg((c) =>
    c.query(`insert into public.planning_parameters (key, organization_id, value, description) values ($1, $2, $3::jsonb, 'intelligence api test')`, [key, org, JSON.stringify(value)]));
const dbRows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);

const run = (userId = n.user.centreAAdmin, facilityId = n.fac.centreA) => post('/api/intelligence/runs', { facilityId }, userId);
const recs = async (query = '', userId = n.user.centreAAdmin) => (await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreA}${query}`, userId)).body;
const pendingRec = async (group: string) => (await recs('&status=PENDING&pageSize=100')).data.find((r: any) => r.payload.blood_group_id === n.bg[group as 'O-']);

beforeAll(async () => {
  n = await seedNetwork();
  manager = await createUser('IntManager', n.org.abc, n.fac.centreA);
  await grantRole(manager, 'INVENTORY_MANAGER', n.org.abc, n.fac.centreA);
  staff = await createUser('IntStaff', n.org.abc, n.fac.centreA);
  await grantRole(staff, 'BLOOD_BANK_STAFF', n.org.abc, n.fac.centreA);
  superAdmin = await createUser('IntSuper', null, null);
  await grantRole(superAdmin, 'SUPER_ADMIN', null, null);

  // Centre A O- PRBC: 3 usable, 1 quarantined (incoming), 2 issued.  A+ PRBC: 1 usable, 3 issued.
  for (let i = 0; i < 3; i += 1) await unit(n.fac.centreA, 'O-');
  await unit(n.fac.centreA, 'O-', 'QUARANTINED');
  for (let i = 0; i < 2; i += 1) await issue(await unit(n.fac.centreA, 'O-'));
  await unit(n.fac.centreA, 'A+');
  for (let i = 0; i < 3; i += 1) await issue(await unit(n.fac.centreA, 'A+'));
  // Centre B (another organization) has stock and history of its own.
  for (let i = 0; i < 6; i += 1) await unit(n.fac.centreB, 'O-');
});

afterAll(async () => {
  await withPg((c) => c.query("delete from public.planning_parameters where description = 'intelligence api test'"));
  await db.disconnect();
});

describe('access control', () => {
  it('requires authentication on every endpoint', async () => {
    expect((await get('/api/intelligence/predictions')).status).toBe(401);
    expect((await get('/api/intelligence/recommendations')).status).toBe(401);
    expect((await post('/api/intelligence/runs', { facilityId: n.fac.centreA })).status).toBe(401);
    expect((await post(`/api/intelligence/recommendations/${randomUUID()}/decision`, { decision: 'APPROVE' })).status).toBe(401);
  });

  it('hospital roles, donors, public requesters and super admins are forbidden everywhere', async () => {
    for (const userId of [n.user.drSharma, n.user.publicUser, n.user.donorUser, n.user.sunriseStaff, superAdmin]) {
      expect((await get('/api/intelligence/predictions', userId)).status).toBe(403);
      expect((await get('/api/intelligence/recommendations', userId)).status).toBe(403);
      expect((await run(userId)).status).toBe(403);
      expect((await post(`/api/intelligence/recommendations/${randomUUID()}/decision`, { decision: 'APPROVE' }, userId)).status).toBe(403);
    }
  });

  it('read-only staff can read but not run; managers can run but not decide', async () => {
    expect((await get(`/api/intelligence/predictions?facilityId=${n.fac.centreA}`, staff)).status).toBe(200);
    expect((await run(staff)).status).toBe(403);
    expect((await run(manager)).status).toBe(201);
    expect((await post(`/api/intelligence/recommendations/${randomUUID()}/decision`, { decision: 'APPROVE' }, manager)).status).toBe(403);
  });

  it('another organization cannot read, run or use this facility (404, nothing revealed)', async () => {
    expect((await get(`/api/intelligence/predictions?facilityId=${n.fac.centreA}`, n.user.centreBAdmin)).status).toBe(404);
    expect((await get(`/api/intelligence/recommendations?facilityId=${n.fac.centreA}`, n.user.centreBAdmin)).status).toBe(404);
    expect((await run(n.user.centreBAdmin, n.fac.centreA)).status).toBe(404);
    expect((await run(n.user.centreAAdmin, randomUUID())).status).toBe(404);
    const forged = await request(app).post('/api/intelligence/runs').set({ ...as(n.user.centreBAdmin), 'X-Facility-Id': n.fac.centreA, 'X-Role': 'ORG_ADMIN' }).send({ facilityId: n.fac.centreA });
    expect(forged.status).toBe(404);
  });

  it('a facility that holds no stock cannot be run (422)', async () => {
    const res = await run(n.user.abcOrgAdmin, n.fac.abcHospital);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FACILITY_HOLDS_NO_INVENTORY');
  });

  it('validates the body strictly', async () => {
    for (const body of [{}, { facilityId: 'x' }, { facilityId: n.fac.centreA, extra: 1 }]) {
      expect((await post('/api/intelligence/runs', body, n.user.centreAAdmin)).status).toBe(400);
    }
  });
});

describe('a run without configured parameters produces nothing invented', () => {
  it('writes no predictions and no recommendations, reports why, and still audits the run', async () => {
    const before = await dbRows("select count(*)::int as n from public.audit_logs where action = 'prediction.generate' and facility_id = $1", [n.fac.centreA]);
    const res = await run();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      predictionsWritten: 0, procurementRecommendations: [], seriesSkipped: [{ reason: 'HISTORY_NOT_CONFIGURED', count: 8 * 4 }],
      model: { name: 'trailing-average-baseline', kind: 'RULE_BASED' },
    });
    expect(await dbRows('select id from public.predictions where facility_id = $1', [n.fac.centreA])).toHaveLength(0);
    const after = await dbRows("select count(*)::int as n from public.audit_logs where action = 'prediction.generate' and facility_id = $1", [n.fac.centreA]);
    expect(after[0].n).toBe(before[0].n + 1);
  });
});

describe('demand forecast and procurement recommendations', () => {
  let first: any;

  beforeAll(async () => {
    await param('forecast.history_days', 10);
    await param('forecast.horizon_days', 14);
    await param('coverage.target_days', 30);
    await param('coverage.risk_bands', { criticalBelowDays: 5, highBelowDays: 10, mediumBelowDays: 25 });
    first = (await run()).body.data;
  });

  it('writes a DEMAND and a SHORTAGE prediction only for series with consumption, plus zero-demand DEMAND rows elsewhere', async () => {
    // 32 series: DEMAND for all; SHORTAGE only for O-/PRBC and A+/PRBC (the only ones with issued units)
    const rows = await dbRows('select prediction_type::text as t, count(*)::int as n from public.predictions where facility_id = $1 and superseded_at is null group by 1', [n.fac.centreA]);
    expect(Object.fromEntries(rows.map((r) => [r.t, r.n]))).toEqual({ DEMAND: 32, SHORTAGE: 2 });
    expect(first.predictionsWritten).toBe(34);
  });

  it('O− PRBC: demand, snapshot, cover and risk follow the documented formula', async () => {
    const [d] = await dbRows(
      `select * from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'DEMAND' and superseded_at is null`,
      [n.fac.centreA, n.bg['O-'], n.comp.PRBC]);
    expect(Number(d.predicted_daily_demand)).toBeCloseTo(0.2, 3); // 2 issued / 10 days
    expect(Number(d.predicted_quantity)).toBeCloseTo(2.8, 3); // × 14 days
    expect(d).toMatchObject({ horizon_days: 14, usable_units: 3, reserved_units: 0, incoming_units: 1, pending_request_units: null, confidence_score: null, confidence_method: null, model_name: 'trailing-average-baseline', model_version: '1' });
    const [s] = await dbRows(
      `select * from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'SHORTAGE' and superseded_at is null`,
      [n.fac.centreA, n.bg['O-'], n.comp.PRBC]);
    expect(Number(s.days_of_cover)).toBeCloseTo(20, 2); // (3 usable + 1 incoming) / 0.2
    expect(s.shortage_risk).toBe('MEDIUM'); // 10 ≤ 20 < 25
    expect(s.predicted_shortage_date).toBeNull(); // cover outlasts the 14-day horizon
    expect(s.explanation.parameters_used).toMatchObject({ 'forecast.history_days': 10, 'coverage.target_days': 30 });
    expect(s.explanation.assumptions.join(' ')).toMatch(/pending_request_units/);
  });

  it('A+ PRBC: a short cover is CRITICAL and dates the shortage inside the horizon', async () => {
    const [s] = await dbRows(
      `select *, predicted_shortage_date::text as shortage_date from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'SHORTAGE' and superseded_at is null`,
      [n.fac.centreA, n.bg['A+'], n.comp.PRBC]);
    expect(Number(s.days_of_cover)).toBeCloseTo(3.33, 2); // 1 / 0.3
    expect(s.shortage_risk).toBe('CRITICAL');
    const [{ expected }] = await dbRows("select ((now() at time zone 'Asia/Kolkata')::date + 3)::text as expected");
    expect(s.shortage_date).toBe(expected);
  });

  it('recommends procurement of exactly the deficit, human-approval pending, marked as rule-based', async () => {
    const created = Object.fromEntries(first.procurementRecommendations.map((r: any) => [r.bloodGroup, r]));
    // O-: target 30 × 0.2 = 6, supply 4 → 2.   A+: 30 × 0.3 = 9, supply 1 → 8
    expect(created['O-']).toMatchObject({ quantity: 2, priority: 'MEDIUM' });
    expect(created['A+']).toMatchObject({ quantity: 8, priority: 'CRITICAL' });
    expect(first.procurementRecommendations).toHaveLength(2);
    expect(first.procurementNotRecommended).toEqual(expect.arrayContaining([{ reason: 'NO_CONSUMPTION_HISTORY', count: 30 }]));

    const rec = await pendingRec('A+');
    expect(rec).toMatchObject({
      type: 'PROCUREMENT', status: 'PENDING', priority: 'CRITICAL', source: 'SYSTEM_RULE', modelVersion: 'trailing-average-baseline@1',
      facilityId: n.fac.centreA, decidedBy: null, modifiedPayload: null,
      payload: { facility_id: n.fac.centreA, blood_group_id: n.bg['A+'], component_id: n.comp.PRBC, quantity: 8, target_cover_days: 30 },
    });
    expect(rec.explanation.what).toContain('Procure 8 unit(s)');
    expect(rec.explanation.why).toContain('below the target of 30 day(s)');
    expect(rec.explanation.data).toMatchObject({ deficit: 8, redistribution_considered: false, daily_demand: 0.3, usable_units: 1 });
    expect(rec.explanation.action).toMatch(/decision only/);
    expect(new Date(rec.validUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it('links each recommendation to the SHORTAGE prediction it came from', async () => {
    const rows = await dbRows(
      `select r.related_prediction_id, p.prediction_type::text as t, p.blood_group_id from public.recommendations r
       join public.predictions p on p.id = r.related_prediction_id where r.facility_id = $1 and r.status = 'PENDING'`, [n.fac.centreA]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.t).toBe('SHORTAGE');
  });

  it('audits the run in the same transaction, with the actor, facility and correlation id', async () => {
    const [row] = await dbRows(
      "select user_id, organization_id, facility_id, entity_type, entity_id, new_value from public.audit_logs where action = 'prediction.generate' and entity_id = $1", [first.runId]);
    expect(row).toMatchObject({ user_id: n.user.centreAAdmin, organization_id: n.org.abc, facility_id: n.fac.centreA, entity_type: 'prediction_run' });
    expect(row.new_value).toMatchObject({ predictions: 34, procurement_recommendations_created: 2 });
  });

  it('does not touch inventory, the ledger, transfers or allocations', async () => {
    const snapshot = () => dbRows(
      `select (select count(*) from public.inventory_units)::int u, (select count(*) from public.transactions)::int t,
              (select count(*) from public.transfers)::int tr, (select count(*) from public.request_allocations)::int a,
              (select max(updated_at) from public.inventory_units) m`);
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);
  });
});

describe('re-running recalculates and supersedes', () => {
  it('keeps exactly one current prediction per series and expires the previous pending recommendations', async () => {
    const before = await recs('&status=PENDING&pageSize=100');
    const res = await run();
    expect(res.status).toBe(201);
    expect(res.body.data.procurementRecommendationsExpired).toBe(before.data.length);
    const dupes = await dbRows(
      `select count(*)::int n from (select 1 from public.predictions where facility_id = $1 and superseded_at is null
         group by blood_group_id, component_id, prediction_type, horizon_days having count(*) > 1) x`, [n.fac.centreA]);
    expect(dupes[0].n).toBe(0);
    const expired = await recs('&status=EXPIRED&pageSize=100');
    expect(expired.data.length).toBeGreaterThanOrEqual(before.data.length);
    const pending = await recs('&status=PENDING&pageSize=100');
    expect(pending.data).toHaveLength(2);
    expect(new Set(pending.data.map((r: any) => r.id))).not.toEqual(new Set(before.data.map((r: any) => r.id)));
  });

  it('counts units in transit to the facility as incoming supply', async () => {
    // A transfer from Centre B (other organization) of 2 O− units to Centre A, dispatched and on the way.
    const transferId = await withPg(async (c) => {
      const { rows } = await c.query(
        `insert into public.transfers (source_facility_id, destination_facility_id, blood_group_id, component_id, requested_quantity, initiated_by)
         values ($1, $2, $3, $4, 2, $5) returning id`,
        [n.fac.centreB, n.fac.centreA, n.bg['O-'], n.comp.PRBC, n.user.centreAAdmin]);
      await c.query('select private.approve_transfer($1, $2, 2)', [rows[0].id, n.user.centreBAdmin]);
      await c.query('select private.dispatch_transfer($1, $2)', [rows[0].id, n.user.centreBAdmin]);
      return rows[0].id as string;
    });
    expect(transferId).toBeDefined();
    await run();
    const [d] = await dbRows(
      `select incoming_units from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'DEMAND' and superseded_at is null`,
      [n.fac.centreA, n.bg['O-'], n.comp.PRBC]);
    expect(d.incoming_units).toBe(3); // 1 quarantined + 2 in transit
    // Centre B's own predictions are untouched by Centre A's run
    expect(await dbRows('select id from public.predictions where facility_id = $1', [n.fac.centreB])).toHaveLength(0);
  });

  it('two simultaneous runs are serialised: both succeed and one current row per series remains', async () => {
    const [a, b] = await Promise.all([run(), run(n.user.abcOrgAdmin)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const dupes = await dbRows(
      `select count(*)::int n from (select 1 from public.predictions where facility_id = $1 and superseded_at is null
         group by blood_group_id, component_id, prediction_type, horizon_days having count(*) > 1) x`, [n.fac.centreA]);
    expect(dupes[0].n).toBe(0);
    // O− now has 3 usable + 3 incoming = 6 units = its 30-day target, so only A+ still needs procurement
    expect((await recs('&status=PENDING&pageSize=100')).data.map((r: any) => r.payload.blood_group_id)).toEqual([n.bg['A+']]);
  });
});

describe('reading predictions and recommendations', () => {
  it('lists current predictions, newest run first, filterable and paginated', async () => {
    const all = await get(`/api/intelligence/predictions?facilityId=${n.fac.centreA}&pageSize=100`, n.user.centreAAdmin);
    expect(all.status).toBe(200);
    expect(all.body.pagination).toMatchObject({ total: 34, page: 1 });
    expect(new Set(all.body.data.map((p: any) => p.generatedAt)).size).toBe(1); // a single current run
    const shortage = await get(`/api/intelligence/predictions?facilityId=${n.fac.centreA}&predictionType=SHORTAGE`, n.user.centreAAdmin);
    expect(shortage.body.data).toHaveLength(2);
    expect(shortage.body.data.map((p: any) => p.bloodGroup).sort()).toEqual(['A+', 'O-']);
    const a = shortage.body.data.find((p: any) => p.bloodGroup === 'A+');
    expect(a).toMatchObject({
      component: 'PRBC', type: 'SHORTAGE', horizonDays: 14, daysOfCover: 3.33, shortageRisk: 'CRITICAL', pendingRequestUnits: null,
      confidenceScore: null, confidenceMethod: null, supersededAt: null, model: { name: 'trailing-average-baseline', version: '1' },
    });
    const history = await get(`/api/intelligence/predictions?facilityId=${n.fac.centreA}&currentOnly=false&pageSize=100`, n.user.centreAAdmin);
    expect(history.body.pagination.total).toBeGreaterThan(34);
    const page = await get(`/api/intelligence/predictions?facilityId=${n.fac.centreA}&pageSize=10&page=4`, n.user.centreAAdmin);
    expect(page.body.data).toHaveLength(4);
  });

  it('without facilityId returns only the caller’s own facilities; nothing of another organization', async () => {
    const own = await get('/api/intelligence/predictions?pageSize=100', n.user.centreAAdmin);
    for (const p of own.body.data) expect(p.facilityId).toBe(n.fac.centreA);
    const other = await get('/api/intelligence/predictions?pageSize=100', n.user.centreBAdmin);
    expect(other.body.data).toEqual([]);
    expect(JSON.stringify(other.body)).not.toContain(n.fac.centreA);
  });

  it('validates queries strictly', async () => {
    for (const path of ['/api/intelligence/predictions?facilityId=x', '/api/intelligence/predictions?predictionType=EXPIRY', '/api/intelligence/recommendations?status=NOPE', '/api/intelligence/predictions?pageSize=500', '/api/intelligence/predictions?zzz=1']) {
      expect((await get(path, n.user.centreAAdmin)).status, path).toBe(400);
    }
  });

  it('never exposes patient, donor or personal data', async () => {
    const all = JSON.stringify([(await get('/api/intelligence/predictions?pageSize=100', n.user.centreAAdmin)).body, await recs('&pageSize=100')]);
    expect(all).not.toMatch(/patient|phone|email/i);
  });
});

describe('deciding a procurement recommendation', () => {
  beforeAll(async () => {
    // a higher target so both O− and A+ need procurement again: O− 60 × 0.2 − 6 = 6, A+ 60 × 0.3 − 1 = 17
    await dbRows("update public.planning_parameters set value = '60'::jsonb where key = 'coverage.target_days' and description = 'intelligence api test'");
    await run();
  });

  const decide = (id: string, body: unknown, userId = n.user.centreAAdmin) => post(`/api/intelligence/recommendations/${id}/decision`, body, userId);
  const audit = (id: string) => dbRows('select action, user_id, organization_id, facility_id, old_value, new_value from public.audit_logs where entity_id = $1 order by occurred_at', [id]);

  it('approve: records the decision, the decider and an audit row; changes nothing else', async () => {
    const rec = await pendingRec('O-');
    const before = (await dbRows('select count(*)::int n from public.transfers'))[0].n;
    const res = await decide(rec.id, { decision: 'APPROVE' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: rec.id, status: 'APPROVED', decidedBy: n.user.centreAAdmin, modifiedPayload: null, decisionNote: null });
    expect(res.body.data.decidedAt).toBeTruthy();
    expect(await audit(rec.id)).toEqual([
      { action: 'recommendation.approve', user_id: n.user.centreAAdmin, organization_id: n.org.abc, facility_id: n.fac.centreA, old_value: { status: 'PENDING', quantity: 6 }, new_value: { status: 'APPROVED', quantity: 6 } },
    ]);
    expect((await dbRows('select count(*)::int n from public.transfers'))[0].n).toBe(before); // decision only
  });

  it('a decision cannot be repeated or overturned (409)', async () => {
    const rec = (await recs('&status=APPROVED')).data[0];
    for (const body of [{ decision: 'APPROVE' }, { decision: 'REJECT', note: 'changed my mind' }]) {
      const res = await decide(rec.id, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('RECOMMENDATION_NOT_PENDING');
    }
    expect(await audit(rec.id)).toHaveLength(1);
  });

  it('modify: changes only the quantity, keeps the original payload fields, requires a note', async () => {
    const rec = await pendingRec('A+');
    expect((await decide(rec.id, { decision: 'MODIFY', note: 'no quantity' })).status).toBe(400);
    expect((await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 5 })).status).toBe(400);
    expect((await decide(rec.id, { decision: 'APPROVE', modifiedQuantity: 5 })).status).toBe(400);
    expect((await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 0, note: 'x' })).status).toBe(400);
    const res = await decide(rec.id, { decision: 'MODIFY', modifiedQuantity: 5, note: 'budget limit' }, n.user.abcOrgAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'MODIFIED', decidedBy: n.user.abcOrgAdmin, decisionNote: 'budget limit' });
    expect(res.body.data.modifiedPayload).toEqual({ ...rec.payload, quantity: 5 });
    expect(res.body.data.payload.quantity).toBe(17); // the original recommendation is preserved
    const [entry] = await audit(rec.id);
    expect(entry).toMatchObject({ action: 'recommendation.modify', old_value: { status: 'PENDING', quantity: 17 }, new_value: { status: 'MODIFIED', quantity: 5 } });
    expect(JSON.stringify(entry)).not.toContain('budget limit'); // free text stays out of the audit log
  });

  it('reject requires a note and is audited', async () => {
    await run();
    const rec = await pendingRec('A+');
    expect((await decide(rec.id, { decision: 'REJECT' })).status).toBe(400);
    const res = await decide(rec.id, { decision: 'REJECT', note: 'stock arriving by other means' });
    expect(res.body.data).toMatchObject({ status: 'REJECTED', decisionNote: 'stock arriving by other means' });
    expect((await audit(rec.id))[0].action).toBe('recommendation.reject');
  });

  it('is denied to readers without a deciding role and hidden from other organizations', async () => {
    await run();
    const rec = await pendingRec('O-');
    expect((await decide(rec.id, { decision: 'APPROVE' }, staff)).status).toBe(403);
    expect((await decide(rec.id, { decision: 'APPROVE' }, manager)).status).toBe(403);
    expect((await decide(rec.id, { decision: 'APPROVE' }, n.user.centreBAdmin)).status).toBe(404);
    expect((await decide(randomUUID(), { decision: 'APPROVE' })).status).toBe(404);
    expect((await decide('not-a-uuid', { decision: 'APPROVE' })).status).toBe(400);
    expect((await pendingRec('O-')).status).toBe('PENDING');
  });

  it('an expired recommendation cannot be decided', async () => {
    const rec = await pendingRec('O-');
    await dbRows("update public.recommendations set valid_until = now() - interval '1 minute' where id = $1", [rec.id]);
    const res = await decide(rec.id, { decision: 'APPROVE' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECOMMENDATION_EXPIRED');
    expect((await dbRows('select status::text as s from public.recommendations where id = $1', [rec.id]))[0].s).toBe('PENDING');
  });

  it('concurrent decisions: exactly one wins', async () => {
    await run();
    const rec = await pendingRec('A+');
    const results = await Promise.all([decide(rec.id, { decision: 'APPROVE' }), decide(rec.id, { decision: 'REJECT', note: 'race' }, n.user.abcOrgAdmin)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await audit(rec.id)).toHaveLength(1);
  });
});
