import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO } from '../../src/demo/ids.js';
import { resetDemoData, seedDemoData, type DemoSummary } from '../../src/demo/seedDemoData.js';
import { buildApp, fakeAiClient, testConfig, tokenFor } from '../support/testApp.js';
import { realDatabase, withPg } from './harness.js';

/**
 * The DEMO_ONLY dataset (docs/03a_Database_Schema_Proposal.md §12), seeded against the same
 * throwaway local PostgreSQL every other API test uses — never hosted. This file both validates
 * the seed's own invariants and drives the full workflow (inventory → demand forecast →
 * redistribution → human approval → transfer → emergency → donor activation) exactly as a real
 * caller would, over real HTTP, through the real Express app.
 */
const db = realDatabase();
const demoAiClient = fakeAiClient((_path, body) => {
  const history = (body as { history: { units_issued: number }[] }).history;
  const total = history.reduce((sum, day) => sum + day.units_issued, 0);
  // A deliberately distinguishable "AI" figure (1.5× the plain average) so a stored prediction can
  // only show this number if the AI path was actually used, never the trailing-average baseline.
  const daily = history.length > 0 ? (total / history.length) * 1.5 : 0;
  return {
    predicted_daily_demand: daily, predicted_quantity: daily * 14, confidence_score: 0.8,
    confidence_method: 'demo_fake_model', model_name: 'demo-fake-ai-model', model_version: '1', history_days_used: history.length,
  };
});
const appWithAi = buildApp({ db, aiClient: demoAiClient, config: testConfig({ ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }) });
const appNoAi = buildApp({ db, aiClient: fakeAiClient(), config: testConfig({ ALLOW_DEMO_COMPATIBILITY_RULES: 'true' }) });

const { facilities: fac, users: u } = DEMO;
const as = (userId: string) => ({ Authorization: `Bearer ${tokenFor(userId)}` });
const get = (app: typeof appWithAi, path: string, userId: string) => request(app).get(path).set(as(userId));
const post = (app: typeof appWithAi, path: string, body: unknown, userId: string) => request(app).post(path).set(as(userId)).send(body as object);
const rows = <T = any>(sql: string, args: unknown[] = []) => withPg(async (c) => (await c.query(sql, args)).rows as T[]);

let summary: DemoSummary;

beforeAll(async () => {
  summary = await withPg((client) => seedDemoData(client));
});
afterAll(async () => {
  await withPg((client) => resetDemoData(client));
  // Test-only hygiene, beyond resetDemoData's own contract: donors carry no facility/tenant scope,
  // so leaving them behind would leak into other test files sharing this same throwaway database
  // (donations have no append-only guard, so both are safe to remove here).
  await withPg(async (client) => {
    await client.query("delete from public.donor_activation_recipients where donor_id in (select id from public.donors where email like 'demo-donor-%@bloodlink.invalid')");
    await client.query("delete from public.donations where donor_id in (select id from public.donors where email like 'demo-donor-%@bloodlink.invalid')");
    await client.query("delete from public.donors where email like 'demo-donor-%@bloodlink.invalid'").catch(() => undefined);
  });
  await db.disconnect();
});

describe('the seed itself', () => {
  it('creates the documented organizations, facilities and users', () => {
    expect(summary.organizations.map((o) => o.name).sort()).toEqual(['ABC Hospital', 'City Blood Centre', 'Sunrise Clinic'].sort());
    expect(summary.facilities.map((f) => f.name).sort()).toEqual(['ABC Hospital', 'Centre A', 'Centre B', 'Sunrise Clinic'].sort());
    expect(summary.users).toHaveLength(7);
  });

  it('covers multiple blood groups and every supported component', async () => {
    const groups = await rows('select distinct blood_group_id from public.inventory_units where facility_id = any($1::uuid[])', [Object.values(fac)]);
    const components = await rows('select distinct component_id from public.inventory_units where facility_id = any($1::uuid[])', [Object.values(fac)]);
    expect(groups.length).toBeGreaterThanOrEqual(4);
    expect(components).toHaveLength(4); // WHOLE_BLOOD, PRBC, PLASMA_FFP, PLATELETS all represented
  });

  it('created exactly 12 donors eligible for activation, and the other 6 deliberately excluded', () => {
    expect(summary.donors.eligibleForActivation).toBe(12);
    expect(summary.donors.total).toBe(23); // 12 eligible + 7 excluded (one per exclusion reason, incl. no-consent) + 4 other-group
  });

  it('is internally consistent: every unit’s latest ledger entry matches its current status', async () => {
    const mismatches = await rows(`
      select u.id from public.inventory_units u
      where u.facility_id = any($1::uuid[]) and u.status not in (
        select t.to_status from public.transactions t where t.inventory_unit_id = u.id order by t.occurred_at desc limit 1
      )`, [Object.values(fac)]);
    expect(mismatches).toHaveLength(0);
  });

  it('donors.total_donations / last_donation_date match their donations rows (maintained by the database trigger, not the seed)', async () => {
    const mismatches = await rows(`
      select d.id from public.donors d
      where d.email like 'demo-donor-%@bloodlink.invalid' and d.total_donations <> (
        select count(*)::int from public.donations dn where dn.donor_id = d.id and dn.eligibility_status = 'ELIGIBLE' and dn.volume_ml is not null
      )`);
    expect(mismatches).toHaveLength(0);
  });

  it('the ledger sums to the same daily counts v_daily_consumption reports', async () => {
    const [{ n }] = await rows(
      `select count(*)::int as n from public.v_daily_consumption v
       where v.facility_id = $1 and v.blood_group_id = $2 and v.component_id = $3
         and v.units_issued <> (select count(*) from public.transactions t
           where t.facility_id = v.facility_id and t.blood_group_id = v.blood_group_id and t.component_id = v.component_id
             and t.transaction_type = 'INVENTORY_ISSUED' and (t.occurred_at at time zone 'Asia/Kolkata')::date = v.day)`,
      [fac.centreA, summary.bloodGroups['O-'], summary.components.PRBC],
    );
    expect(n).toBe(0);
  });

  it('seeded requests: one ALLOCATED (a confirmed hold), one still OPEN — never bypassing the allocation guard', async () => {
    const statuses = await rows('select request_number, status::text as status from public.requests where id = any($1::uuid[]) order by request_number', [summary.requests.map((r) => r.id)]);
    expect(statuses.map((r) => r.status)).toEqual(['ALLOCATED', 'OPEN']);
    const allocations = await rows(
      "select status::text as status from public.request_allocations ra join public.request_items ri on ri.id = ra.request_item_id where ri.request_id = $1",
      [summary.requests[0]!.id],
    );
    expect(allocations).toHaveLength(4);
    expect(allocations.every((a) => a.status === 'CONFIRMED')).toBe(true);
  });

  it('seeding a second time fails clearly and safely — it never silently resets or recreates the dataset', async () => {
    // The ledger this seed writes (public.transactions) is append-only by design (migration 003):
    // it cannot be deleted once real activity has been recorded, so a second seedDemoData() call
    // must refuse rather than attempt a partial, silent rewrite. Confirm the refusal, and that the
    // first seed's facts (organizations, facilities, historical ledger, donors) are completely
    // untouched by the attempt.
    await expect(withPg((client) => seedDemoData(client))).rejects.toThrow(/already exists/i);
    const [{ n: organizations }] = await rows('select count(*)::int as n from public.organizations where id = any($1::uuid[])', [Object.values(DEMO.organizations)]);
    const [{ n: units }] = await rows('select count(*)::int as n from public.inventory_units where facility_id = any($1::uuid[])', [Object.values(fac)]);
    const [{ n: issued }] = await rows(
      "select count(*)::int as n from public.transactions where facility_id = any($1::uuid[]) and transaction_type = 'INVENTORY_ISSUED'",
      [Object.values(fac)],
    );
    expect(organizations).toBe(3);
    expect(units).toBeGreaterThan(0);
    expect(issued).toBe(summary.historicalUnitsIssued);
  });

});

describe('workflow: inventory summary (no intelligence run needed — it reads the live ledger directly)', () => {
  it('Centre A, O−/PRBC: the shortage-risk, expiring-soon series — computed, not seeded', async () => {
    const res = await get(appNoAi, `/api/inventory/summary?facilityId=${fac.centreA}`, u.centreAAdmin);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.bloodGroup.code === 'O-' && r.component.code === 'PRBC');
    expect(row.quantities).toMatchObject({ available: 16, reserved: 4, pendingAcceptance: 2, expiringSoon: 3 });
    // Inventory summary's shortage classification uses `available` only (not incoming) — 16 / 4.0/day.
    expect(row.shortage).toMatchObject({ status: 'SHORTAGE', riskLevel: 'HIGH', daysOfCover: 4 });
    expect(row.expiry).toMatchObject({ status: 'AT_RISK', expiringUnits: 3 });
  });

  it('Centre A, A+/PRBC: the healthy series', async () => {
    const res = await get(appNoAi, `/api/inventory/summary?facilityId=${fac.centreA}`, u.centreAAdmin);
    const row = res.body.data.find((r: any) => r.bloodGroup.code === 'A+' && r.component.code === 'PRBC');
    expect(row.quantities.available).toBe(30);
    expect(row.shortage).toMatchObject({ status: 'HEALTHY', riskLevel: 'LOW', daysOfCover: 30 });
  });

  it('Centre B, O−/PRBC: the transferable-surplus source, with its own near-expiry units', async () => {
    const res = await get(appNoAi, `/api/inventory/summary?facilityId=${fac.centreB}`, u.centreBAdmin);
    const row = res.body.data.find((r: any) => r.bloodGroup.code === 'O-' && r.component.code === 'PRBC');
    expect(row.quantities).toMatchObject({ available: 32, expiringSoon: 6 });
  });
});

describe('workflow: demand intelligence run', () => {
  it('uses the AI forecast when the AI client is available (a number the baseline could never produce)', async () => {
    const res = await post(appWithAi, '/api/intelligence/runs', { facilityId: fac.centreA }, u.centreAAdmin);
    expect(res.status).toBe(201);
    expect(res.body.data.demandForecastMethods.AI_SERVICE).toBeGreaterThan(0);
    const [demand] = await rows(
      "select predicted_daily_demand, model_name from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'DEMAND' and superseded_at is null",
      [fac.centreA, summary.bloodGroups['O-'], summary.components.PRBC],
    );
    expect(Number(demand.predicted_daily_demand)).toBeCloseTo(6.0, 3); // 4.0 baseline × the fake model's 1.5×
    expect(demand.model_name).toBe('demo-fake-ai-model');
  });

  it('falls back to the trailing-average baseline when the AI service is unavailable', async () => {
    const res = await post(appNoAi, '/api/intelligence/runs', { facilityId: fac.centreA }, u.centreAAdmin);
    expect(res.status).toBe(201);
    expect(res.body.data.demandForecastMethods).toEqual({ AI_SERVICE: 0, BASELINE: expect.any(Number) });
    const [demand] = await rows(
      "select predicted_daily_demand, model_name, confidence_score from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'DEMAND' and superseded_at is null",
      [fac.centreA, summary.bloodGroups['O-'], summary.components.PRBC],
    );
    expect(Number(demand.predicted_daily_demand)).toBeCloseTo(4.0, 3); // 120 issued / 30 days, exactly
    expect(demand).toMatchObject({ model_name: 'trailing-average-baseline', confidence_score: null });

    const [shortage] = await rows(
      "select days_of_cover, shortage_risk from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'SHORTAGE' and superseded_at is null",
      [fac.centreA, summary.bloodGroups['O-'], summary.components.PRBC],
    );
    expect(Number(shortage.days_of_cover)).toBeCloseTo(4.5, 2);
    expect(shortage.shortage_risk).toBe('HIGH');

    const [procurement] = await rows(
      "select payload from public.recommendations where facility_id = $1 and recommendation_type = 'PROCUREMENT' and status = 'PENDING'", [fac.centreA],
    );
    expect(procurement.payload).toMatchObject({ quantity: 2, target_cover_days: 5 }); // ceil(5×4.0 − 18)
  });

  it('also runs for Centre B (the redistribution source needs its own current demand figure)', async () => {
    const res = await post(appNoAi, '/api/intelligence/runs', { facilityId: fac.centreB }, u.centreBAdmin);
    expect(res.status).toBe(201);
    const [demand] = await rows(
      "select predicted_daily_demand from public.predictions where facility_id = $1 and blood_group_id = $2 and component_id = $3 and prediction_type = 'DEMAND' and superseded_at is null",
      [fac.centreB, summary.bloodGroups['O-'], summary.components.PRBC],
    );
    expect(Number(demand.predicted_daily_demand)).toBeCloseTo(1.0, 3);
  });
});

describe('workflow: redistribution → human approval → transfer', () => {
  let recommendationId: string;

  it('recommends Centre B as the source, for exactly the computed deficit', async () => {
    const res = await post(appNoAi, '/api/intelligence/redistribution/runs', { facilityId: fac.centreA }, u.centreAAdmin);
    expect(res.status).toBe(201);
    expect(res.body.data.redistributionRecommendations).toEqual([
      { id: expect.any(String), bloodGroup: 'O-', component: 'PRBC', quantity: 2, priority: 'HIGH', source: { id: fac.centreB, name: 'Centre B' } },
    ]);
    recommendationId = res.body.data.redistributionRecommendations[0].id;
  });

  it('a human approves it, which proposes a transfer (not yet reserved)', async () => {
    const res = await post(appNoAi, `/api/intelligence/recommendations/${recommendationId}/decision`, { decision: 'APPROVE' }, u.abcOrgAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', transferId: expect.any(String) });
    const [transfer] = await rows('select * from public.transfers where id = $1', [res.body.data.transferId]);
    expect(transfer).toMatchObject({ status: 'PROPOSED', source_facility_id: fac.centreB, destination_facility_id: fac.centreA, requested_quantity: 2 });
  });

  it('the source approves it: units are reserved (first-expiry-first) — the demo’s near-expiry Centre B stock goes first', async () => {
    const [transfer] = await rows('select id from public.transfers where destination_facility_id = $1 and status = $2', [fac.centreA, 'PROPOSED']);
    const res = await post(appNoAi, `/api/transfers/${transfer.id}/approve`, {}, u.centreBAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', approvedQuantity: 2 });
    const reserved = await rows(
      `select u.unit_code from public.transfer_items ti join public.inventory_units u on u.id = ti.inventory_unit_id where ti.transfer_id = $1`,
      [transfer.id],
    );
    expect(reserved).toHaveLength(2);
    expect(reserved.every((r) => r.unit_code.includes('SOON'))).toBe(true); // the 6 near-expiry units expire first
  });
});

describe('workflow: emergency request, using the seeded DEMO_ONLY compatibility rule', () => {
  let requestId: string;
  let recommendationId: string;

  it('Sunrise Clinic creates a verified emergency request', async () => {
    const res = await post(
      appNoAi, '/api/emergency/requests',
      { facilityId: fac.sunriseClinic, bloodGroupId: summary.bloodGroups['O-'], componentId: summary.components.PRBC, quantity: 2, urgency: 'CRITICAL', requiredBy: new Date(Date.now() + 6 * 3_600_000).toISOString() },
      u.sunriseEmergencyStaff,
    );
    expect(res.status).toBe(201);
    requestId = res.body.data.id;
  });

  it('ranks Centre B first: Centre A is already short and keeps its own reserve', async () => {
    const res = await post(appNoAi, `/api/emergency/requests/${requestId}/source-selection`, {}, u.sunriseEmergencyStaff);
    expect(res.status).toBe(201);
    const centreA = res.body.data.ranked.find((r: any) => r.facility_id === fac.centreA);
    const centreB = res.body.data.ranked.find((r: any) => r.facility_id === fac.centreB);
    expect(centreB).toMatchObject({ rank: 1, can_fulfil: true });
    expect(centreA?.rank ?? null).not.toBe(1); // excluded or ranked behind — never offered ahead of a source with real spare capacity
    expect(res.body.data.recommendationId).toEqual(expect.any(String));
    recommendationId = res.body.data.recommendationId;
  });

  it('approving places a temporary hold at Centre B only — no blood released yet', async () => {
    const res = await post(appNoAi, `/api/emergency/source-selections/${recommendationId}/decision`, { decision: 'APPROVE' }, u.sunriseEmergencyStaff);
    expect(res.status).toBe(200);
    const holds = await rows(
      `select ra.status::text as status, ra.source_facility_id from public.request_allocations ra join public.request_items ri on ri.id = ra.request_item_id where ri.request_id = $1`,
      [requestId],
    );
    expect(holds).toHaveLength(2);
    expect(holds.every((h) => h.source_facility_id === fac.centreB && h.status === 'RESERVED')).toBe(true);
  });

  it('Centre B confirms the hold', async () => {
    const allocationIds = (await rows(
      `select ra.id from public.request_allocations ra join public.request_items ri on ri.id = ra.request_item_id where ri.request_id = $1`,
      [requestId],
    )).map((r) => r.id);
    const res = await post(appNoAi, '/api/emergency/holds/confirm', { allocationIds }, u.centreBAdmin);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ confirmed: 2 });
  });
});

describe('workflow: donor activation, where its prerequisites (a current shortage, radius and interval) are satisfied', () => {
  let recommendationId: string;

  it('recommends activating exactly the eligible donors, up to the deficit', async () => {
    const res = await post(appNoAi, '/api/donor-activations/runs', { facilityId: fac.centreA }, u.centreAAdmin);
    expect(res.status).toBe(201);
    // donors carry no organization/tenant scope, so a shared test database may have other test
    // files' donors also near these coordinates; the seed's own 12 are guaranteed present (asserted
    // in "the seed itself" above), so eligibleDonorCount is at least 12, and either way the target
    // is capped at the deficit (2), never at how many donors exist.
    const [rec] = res.body.data.donorActivationRecommendations;
    expect(rec).toMatchObject({ id: expect.any(String), bloodGroup: 'O-', component: 'PRBC', unitsNeeded: 2, targetDonorCount: 2, priority: 'HIGH' });
    expect(rec.eligibleDonorCount).toBeGreaterThanOrEqual(12);
    recommendationId = rec.id;
  });

  it('approving creates the activation and targets only the 12 eligible donors — never the 6 excluded ones', async () => {
    const res = await post(appNoAi, `/api/intelligence/recommendations/${recommendationId}/decision`, { decision: 'APPROVE' }, u.abcOrgAdmin);
    expect(res.status).toBe(200);
    const activationId = res.body.data.donorActivationId;
    const recipients = await rows('select donor_id from public.donor_activation_recipients where activation_id = $1', [activationId]);
    expect(recipients).toHaveLength(2);
    const excludedNames = ['Demo Donor Far 1', 'Demo Donor Far 2', 'Demo Donor Far 3', 'Demo Donor Recent 1', 'Demo Donor Recent 2', 'Demo Donor Unavailable', 'Demo Donor No Consent'];
    const targetedNames = await rows('select full_name from public.donors where id = any($1::uuid[])', [recipients.map((r) => r.donor_id)]);
    for (const name of targetedNames.map((r) => r.full_name)) expect(excludedNames).not.toContain(name);

    // notify: none of the demo donors have a linked BloodLink account, so none can be delivered in-app —
    // reported honestly, never faked as delivered.
    const notifyRes = await post(appNoAi, `/api/donor-activations/${activationId}/notify`, {}, u.centreAAdmin);
    expect(notifyRes.body.data).toEqual({ notified: 2, delivered: 0, failed: 2 });
  });
});

// Runs last on purpose: resetDemoData deletes the demo users/roles/planning parameters that every
// workflow describe above depends on, so nothing after this point can authenticate or run intelligence.
describe('resetDemoData (destructive — must run after every other workflow test)', () => {
  it('removes planning_parameters unconditionally, and never touches the ledger, requests, facilities or donors', async () => {
    const before = await rows('select count(*)::int as n from public.inventory_units where facility_id = any($1::uuid[])', [Object.values(fac)]);
    const beforeRequests = await rows('select count(*)::int as n from public.requests where patient_facility_id = any($1::uuid[])', [Object.values(fac)]);
    const beforeDonors = await rows("select count(*)::int as n from public.donors where email like 'demo-donor-%@bloodlink.invalid'");
    const beforeIssued = await rows(
      "select count(*)::int as n from public.transactions where facility_id = any($1::uuid[]) and transaction_type = 'INVENTORY_ISSUED'",
      [Object.values(fac)],
    );

    await withPg((client) => resetDemoData(client));

    // Guaranteed, unconditionally: nothing references planning_parameters.
    const [{ n: params }] = await rows("select count(*)::int as n from public.planning_parameters where description = 'DEMO_ONLY seed'");
    expect(params).toBe(0);

    // Best-effort by this point in the suite (the workflow above made every demo user act on a
    // permanent row — `recorded_by`/`initiated_by`/… — so none of them can be removed anymore; that
    // is the correct, honest outcome, not a bug): user/role deletion is not asserted either way.

    // Never touched, regardless: the append-only ledger, requests/allocations, donors.
    const after = await rows('select count(*)::int as n from public.inventory_units where facility_id = any($1::uuid[])', [Object.values(fac)]);
    const afterRequests = await rows('select count(*)::int as n from public.requests where patient_facility_id = any($1::uuid[])', [Object.values(fac)]);
    const afterDonors = await rows("select count(*)::int as n from public.donors where email like 'demo-donor-%@bloodlink.invalid'");
    const afterIssued = await rows(
      "select count(*)::int as n from public.transactions where facility_id = any($1::uuid[]) and transaction_type = 'INVENTORY_ISSUED'",
      [Object.values(fac)],
    );
    expect(after).toEqual(before);
    expect(afterRequests).toEqual(beforeRequests);
    expect(afterDonors).toEqual(beforeDonors);
    expect(afterIssued).toEqual(beforeIssued);
  });

  it('re-seeding after a reset still refuses: resetDemoData does not make the database "fresh" again', async () => {
    // organizations/facilities/the ledger are still there, matching the documented contract.
    await expect(withPg((client) => seedDemoData(client))).rejects.toThrow(/already exists/i);
  });
});
