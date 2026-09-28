import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDemoRules, addUnits, buildNetwork, emergencyRequest, setHoldTimeout } from './fixtures.js';
import { actAs, actAsBackend, connect, expectDbError, inRollback, scalar } from './harness.js';

// Browser access as Supabase roles `authenticated` / `anon` (§10). Writes are never allowed.
let c: pg.Client;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.end();
});

const count = (sql: string, params: unknown[] = []) => scalar<number>(c, `select count(*)::int from (${sql}) x`, params);

async function scenario() {
  const n = await buildNetwork(c);
  await addDemoRules(c, n);
  await setHoldTimeout(c, n.org.cbc, n.fac.centreB, 15);
  const bUnits = await addUnits(c, n, n.fac.centreB, 'O-', 3);
  const aUnits = await addUnits(c, n, n.fac.centreA, 'O-', 2);
  const { requestId, itemId } = await emergencyRequest(c, n, 2);
  const allocs = (await c.query(`select private.place_source_hold($1, $2, 2, $3, true) as id`,
    [itemId, n.fac.centreB, n.user.sunriseStaff])).rows.map((r) => r.id);
  const transfer = (await c.query(
    `insert into public.transfers (source_facility_id, destination_facility_id, blood_group_id, component_id, requested_quantity, initiated_by)
     values ($1, $2, $3, $4, 1, $5) returning id`, [n.fac.centreB, n.fac.centreA, n.bg['O-'], n.comp.PRBC, n.user.centreAAdmin])).rows[0].id;
  await c.query(`select private.approve_transfer($1, $2, 1)`, [transfer, n.user.centreBAdmin]);
  return { n, bUnits, aUnits, requestId, allocs, transfer };
}

describe('organization isolation', () => {
  it('shows staff only their own facility inventory, allocations and ledger', () =>
    inRollback(c, async () => {
      const { n, bUnits, aUnits, allocs, transfer } = await scenario();
      await actAs(c, n.user.centreAAdmin);
      expect(await count(`select 1 from public.inventory_units where id = any ($1)`, [aUnits])).toBe(2);
      expect(await count(`select 1 from public.inventory_units where id = any ($1)`, [bUnits])).toBe(0);
      expect(await count(`select 1 from public.request_allocations where id = any ($1)`, [allocs])).toBe(0);
      expect(await count(`select 1 from public.transactions where inventory_unit_id = any ($1)`, [bUnits])).toBe(0);
      // Destination sees the transfer record but not its unit rows before receipt.
      expect(await count(`select 1 from public.transfers where id = $1`, [transfer])).toBe(1);
      expect(await count(`select 1 from public.transfer_items where transfer_id = $1`, [transfer])).toBe(0);

      await actAsBackend(c);
      await actAs(c, n.user.centreBStaff);
      expect(await count(`select 1 from public.inventory_units where id = any ($1)`, [bUnits])).toBe(3);
      expect(await count(`select 1 from public.request_allocations where id = any ($1)`, [allocs])).toBe(2);
      expect(await count(`select 1 from public.transfer_items where transfer_id = $1`, [transfer])).toBe(1);
      expect(await count(`select 1 from public.inventory_units where id = any ($1)`, [aUnits])).toBe(0);
    }));

  it('lets the requesting clinic see its request but not the source units or allocations', () =>
    inRollback(c, async () => {
      const { n, bUnits, requestId, allocs } = await scenario();
      await actAs(c, n.user.sunriseStaff);
      expect(await count(`select 1 from public.requests where id = $1`, [requestId])).toBe(1);
      expect(await count(`select 1 from public.request_items where request_id = $1`, [requestId])).toBe(1);
      expect(await count(`select 1 from public.request_allocations where id = any ($1)`, [allocs])).toBe(0);
      expect(await count(`select 1 from public.inventory_units where id = any ($1)`, [bUnits])).toBe(0);
      // An unrelated organization sees none of it.
      await actAsBackend(c);
      await actAs(c, n.user.metroStaff);
      expect(await count(`select 1 from public.requests where id = $1`, [requestId])).toBe(0);
    }));

  it('gives a serving source minimum delivery data only (B(ii))', () =>
    inRollback(c, async () => {
      const { n, requestId } = await scenario();
      await c.query(`update public.requests set notes = 'private clinical note', contact_phone = '9111111111' where id = $1`, [requestId]);
      await actAs(c, n.user.centreBAdmin);
      // No request rows or items through the tables…
      expect(await count(`select 1 from public.requests where id = $1`, [requestId])).toBe(0);
      expect(await count(`select 1 from public.request_items where request_id = $1`, [requestId])).toBe(0);
      // …only the minimal delivery view.
      const res = await c.query(`select * from public.v_served_requests where request_id = $1`, [requestId]);
      expect(res.rows).toHaveLength(1);
      expect(res.fields.map((f) => f.name).sort()).toEqual([
        'blood_group_id', 'component_id', 'destination_facility_id', 'quantity_fulfilled', 'quantity_requested',
        'request_id', 'request_item_id', 'request_number', 'request_status', 'required_by', 'urgency', 'verification_status']);
      expect(res.rows[0]).toMatchObject({ destination_facility_id: n.fac.sunrise, quantity_requested: 2, urgency: 'CRITICAL',
        request_status: 'ALLOCATED', verification_status: 'VERIFIED' });
      expect(JSON.stringify(res.rows)).not.toMatch(/CASE-TEST|9111111111|private clinical note/);

      // Nobody else gets rows from the view.
      for (const outsider of [n.user.metroStaff, n.user.publicUser, n.user.donorUser, n.user.centreAAdmin]) {
        await actAsBackend(c);
        await actAs(c, outsider);
        expect(await count(`select 1 from public.v_served_requests where request_id = $1`, [requestId])).toBe(0);
      }
      await actAsBackend(c);
      await actAs(c, null);
      await expectDbError(c, `select 1 from public.v_served_requests`, [], /permission denied/);
    }));

  it('keeps patient and requester data out of the network aggregate', () =>
    inRollback(c, async () => {
      const { n } = await scenario();
      await c.query(`insert into public.planning_parameters (key, value, description) values ('reserve.floor_days', '1', 'test')`);
      const res = await c.query(`select * from private.network_availability($1, $2::smallint, $3::smallint, 1, false, true)`,
        [n.user.sunriseStaff, n.bg['O-'], n.comp.PRBC]);
      const cols = res.fields.map((f) => f.name);
      for (const forbidden of ['patient_reference', 'contact_phone', 'notes', 'requester_user_id', 'request_id']) {
        expect(cols).not.toContain(forbidden);
      }
    }));

  it('gives public requesters and donors no inventory, allocation or ledger access', () =>
    inRollback(c, async () => {
      const { n, bUnits, allocs } = await scenario();
      for (const user of [n.user.publicUser, n.user.donorUser]) {
        await actAs(c, user);
        expect(await count(`select 1 from public.inventory_units`)).toBe(0);
        expect(await count(`select 1 from public.request_allocations where id = any ($1)`, [allocs])).toBe(0);
        expect(await count(`select 1 from public.transactions where inventory_unit_id = any ($1)`, [bUnits])).toBe(0);
        expect(await count(`select 1 from public.v_inventory_summary`)).toBe(0);
        await actAsBackend(c);
      }
    }));

  it('shows a public requester only their own requests', () =>
    inRollback(c, async () => {
      const { n, requestId } = await scenario();
      const own = (await c.query(
        `insert into public.requests (requester_user_id, patient_facility_id, request_type, required_by, contact_phone)
         values ($1, $2, 'EMERGENCY', now() + interval '1 hour', '9000000000') returning id`, [n.user.publicUser, n.fac.abcHospital])).rows[0].id;
      await actAs(c, n.user.publicUser);
      expect(await count(`select 1 from public.requests where id = $1`, [own])).toBe(1);
      expect(await count(`select 1 from public.requests where id = $1`, [requestId])).toBe(0);
    }));

  it('hides everything from a suspended user', () =>
    inRollback(c, async () => {
      const { n, bUnits } = await scenario();
      await c.query(`update public.users set status = 'SUSPENDED' where id = $1`, [n.user.centreBStaff]);
      await actAs(c, n.user.centreBStaff);
      expect(await count(`select 1 from public.inventory_units where id = any ($1)`, [bUnits])).toBe(0);
    }));
});

describe('browsers are read-only', () => {
  it('denies every write for authenticated users, including the owning staff', () =>
    inRollback(c, async () => {
      const { n, aUnits } = await scenario();
      await actAs(c, n.user.centreAAdmin);
      await expectDbError(c, `update public.inventory_units set status = 'WASTED' where id = $1`, [aUnits[0]], /permission denied/);
      await expectDbError(c, `delete from public.inventory_units where id = $1`, [aUnits[0]], /permission denied/);
      await expectDbError(c, `insert into public.alerts (organization_id, alert_type, severity, title, message)
        values ($1, 'SHORTAGE', 'HIGH', 't', 'm')`, [n.org.abc], /permission denied/);
      await expectDbError(c, `update public.users set full_name = 'x' where id = $1`, [n.user.centreAAdmin], /permission denied/);
    }));

  it('denies browser roles every workflow function', () =>
    inRollback(c, async () => {
      const { n, allocs } = await scenario();
      await actAs(c, n.user.centreBStaff);
      await expectDbError(c, `select private.confirm_hold($1, $2)`, [allocs, n.user.centreBStaff], /permission denied/);
      await expectDbError(c, `select private.transition_unit_status($1, 'WASTED')`, ['00000000-0000-0000-0000-000000000000'], /permission denied/);
      await expectDbError(c, `select * from private.network_availability($1, 1::smallint, 1::smallint, 1)`, [n.user.centreBStaff], /permission denied/);
      await expectDbError(c, `select * from private.issued_unit_codes($1, $2)`, ['00000000-0000-0000-0000-000000000000', n.user.centreBStaff], /permission denied/);
    }));

  it('lets anonymous visitors read reference data only', () =>
    inRollback(c, async () => {
      await actAs(c, null);
      expect(await count(`select 1 from public.blood_groups`)).toBe(9);
      expect(await count(`select 1 from public.components`)).toBe(4);
      await expectDbError(c, `select 1 from public.organizations`, [], /permission denied/);
      await expectDbError(c, `select 1 from public.v_facility_directory`, [], /permission denied/);
    }));

  it('offers every signed-in user the facility directory without operational data', () =>
    inRollback(c, async () => {
      const { n } = await scenario();
      await actAs(c, n.user.publicUser);
      expect(await count(`select 1 from public.v_facility_directory where id = $1`, [n.fac.abcHospital])).toBe(1);
      const cols = (await c.query(`select * from public.v_facility_directory limit 1`)).fields.map((f) => f.name);
      expect(cols).not.toContain('holds_inventory');
      expect(cols).not.toContain('accepts_temporary_holds');
    }));
});

describe('network visibility (U1)', () => {
  it('returns only the approved minimum fields and refuses public requesters', () =>
    inRollback(c, async () => {
      const { n } = await scenario();
      // Needs a reserve floor and a current forecast for the source to be included.
      await c.query(`insert into public.planning_parameters (key, value, description) values ('reserve.floor_days', '1', 'test')`);
      await c.query(`insert into public.predictions (run_id, organization_id, facility_id, blood_group_id, component_id, prediction_type,
          horizon_days, period_start, period_end, predicted_daily_demand, model_name, model_version)
        values (gen_random_uuid(), $1, $2, $3, $4, 'DEMAND', 7, current_date, current_date + 7, 0.5, 'test', 'test')`,
        [n.org.cbc, n.fac.centreB, n.bg['O-'], n.comp.PRBC]);
      const res = await c.query(`select * from private.network_availability($1, $2::smallint, $3::smallint, 1, false, true)`,
        [n.user.sunriseStaff, n.bg['O-'], n.comp.PRBC]);
      expect(res.fields.map((f) => f.name).sort()).toEqual([
        'can_fulfil', 'facility_id', 'facility_name', 'facility_type', 'latitude', 'longitude', 'near_expiry_opportunity',
        'organization_name', 'spare_units_above_reserve']);
      const centreB = res.rows.find((r) => r.facility_id === n.fac.centreB);
      // 3 O− units, 2 held for the emergency (held units are not AVAILABLE), floor = ceil(1 day × 0.5) = 1 → 0 spare.
      expect(centreB).toMatchObject({ can_fulfil: false, spare_units_above_reserve: 0 });
      await expectDbError(c, `select * from private.network_availability($1, $2::smallint, $3::smallint, 1, false, true)`,
        [n.user.publicUser, n.bg['O-'], n.comp.PRBC], /restricted to organization staff/);
    }));
});
