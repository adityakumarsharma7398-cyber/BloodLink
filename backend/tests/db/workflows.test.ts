import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addUnits, buildNetwork } from './fixtures.js';
import { connect, expectDbError, inRollback, one, scalar } from './harness.js';

let c: pg.Client;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.end();
});

describe('request verification (decision 2)', () => {
  const insert = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    return [`insert into public.requests (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(fields)] as const;
  };

  it('lets authorized staff of a verified organization self-verify at creation', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const [sql, params] = insert({ requester_user_id: n.user.drSharma, requester_facility_id: n.fac.abcHospital,
        patient_facility_id: n.fac.abcHospital, request_type: 'ROUTINE', required_by: new Date(Date.now() + 864e5),
        verification_status: 'VERIFIED', verification_method: 'STAFF_AT_CREATION', verified_by: n.user.drSharma, verified_at: new Date() });
      const { rows } = await c.query(sql, params as unknown[]);
      expect(await one(c, `select verifying_facility_id, verification_status::text from public.requests where id = $1`, [rows[0].id]))
        .toEqual({ verifying_facility_id: n.fac.abcHospital, verification_status: 'VERIFIED' });
    }));

  it('keeps public requests PENDING_VERIFICATION and blocks self-verification', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const base = { requester_user_id: n.user.publicUser, patient_facility_id: n.fac.abcHospital, request_type: 'EMERGENCY',
        required_by: new Date(Date.now() + 36e5), contact_phone: '9000000000' };
      const [okSql, okParams] = insert(base);
      const pub = (await c.query(okSql, okParams as unknown[])).rows[0].id;
      expect(await scalar(c, `select verification_status::text from public.requests where id = $1`, [pub])).toBe('PENDING_VERIFICATION');

      const [selfSql, selfParams] = insert({ ...base, verification_status: 'VERIFIED', verification_method: 'STAFF_AT_CREATION',
        verified_by: n.user.publicUser, verified_at: new Date() });
      await expectDbError(c, selfSql, selfParams as unknown[], /STAFF_AT_CREATION requires/);
      const [facSql, facParams] = insert({ ...base, requester_facility_id: n.fac.abcHospital });
      await expectDbError(c, facSql, facParams as unknown[], /no staff role at the requesting facility/);
      const [noPhoneSql, noPhoneParams] = insert({ ...base, contact_phone: null });
      await expectDbError(c, noPhoneSql, noPhoneParams as unknown[], /requests_public_contact/);

      // A different authorized user at the verifying facility reviews it.
      await expectDbError(c, `update public.requests set verification_status = 'VERIFIED', verification_method = 'STAFF_REVIEW',
        verified_by = $2, verified_at = now() where id = $1`, [pub, n.user.metroStaff], /STAFF_REVIEW requires/);
      await c.query(`update public.requests set verification_status = 'VERIFIED', verification_method = 'STAFF_REVIEW',
        verified_by = $2, verified_at = now() where id = $1`, [pub, n.user.drSharma]);
      await expectDbError(c, `update public.requests set verification_status = 'REJECTED', verification_note = 'x' where id = $1`,
        [pub], /decided only once/);
    }));

  it('rejects self-verification by staff of a suspended organization', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      await c.query(`update public.organizations set status = 'SUSPENDED' where id = $1`, [n.org.sunrise]);
      const [sql, params] = insert({ requester_user_id: n.user.sunriseStaff, requester_facility_id: n.fac.sunrise,
        patient_facility_id: n.fac.sunrise, request_type: 'EMERGENCY', required_by: new Date(Date.now() + 36e5) });
      await expectDbError(c, sql, params as unknown[], /no staff role/);
    }));
});

describe('transfer workflow (§6.4)', () => {
  async function proposed() {
    const n = await buildNetwork(c);
    await addUnits(c, n, n.fac.centreB, 'O-', 6);
    const t = await one<{ id: string }>(c,
      `insert into public.transfers (source_facility_id, destination_facility_id, blood_group_id, component_id,
         requested_quantity, initiated_by, reason)
       values ($1, $2, $3, $4, 5, $5, 'test') returning id`,
      [n.fac.centreB, n.fac.centreA, n.bg['O-'], n.comp.PRBC, n.user.centreAAdmin]);
    return { n, transferId: t.id };
  }

  it('keeps the planned quantity before units are assigned; only the source admin approves', () =>
    inRollback(c, async () => {
      const { n, transferId } = await proposed();
      expect(await one(c, `select status::text, requested_quantity, approved_quantity from public.transfers where id = $1`, [transferId]))
        .toEqual({ status: 'PROPOSED', requested_quantity: 5, approved_quantity: null });
      expect(await scalar(c, `select count(*)::int from public.transfer_items where transfer_id = $1`, [transferId])).toBe(0);
      await expectDbError(c, `select private.approve_transfer($1, $2, 5)`, [transferId, n.user.centreAAdmin], /source BLOOD_BANK_ADMIN/);
      await expectDbError(c, `update public.transfers set status = 'APPROVED' where id = $1`, [transferId], /private transfer functions/);
      await c.query(`select private.approve_transfer($1, $2, 4)`, [transferId, n.user.centreBAdmin]);
      expect(await one(c, `select status::text, approved_quantity, (select count(*)::int from public.transfer_items where transfer_id = $1) as items
        from public.transfers where id = $1`, [transferId])).toEqual({ status: 'APPROVED', approved_quantity: 4, items: 4 });
    }));

  it('moves units source → destination with ledger rows at each facility', () =>
    inRollback(c, async () => {
      const { n, transferId } = await proposed();
      await c.query(`select private.approve_transfer($1, $2, 3)`, [transferId, n.user.centreBAdmin]);
      await expectDbError(c, `select private.dispatch_transfer($1, $2)`, [transferId, n.user.centreAAdmin], /staff of the source/);
      await c.query(`select private.dispatch_transfer($1, $2)`, [transferId, n.user.centreBStaff]);
      await expectDbError(c, `select private.receive_transfer($1, $2)`, [transferId, n.user.centreBStaff], /staff of the destination/);
      const units = (await c.query(`select inventory_unit_id from public.transfer_items where transfer_id = $1`, [transferId])).rows
        .map((r) => r.inventory_unit_id);
      await c.query(`select private.receive_transfer($1, $2, $3)`, [transferId, n.user.centreAAdmin, [units[0]]]);

      const final = (await c.query(`select facility_id, status::text from public.inventory_units where id = any ($1) order by status`, [units])).rows;
      expect(final.every((u) => u.facility_id === n.fac.centreA)).toBe(true);
      expect(final.map((u) => u.status).sort()).toEqual(['AVAILABLE', 'AVAILABLE', 'QUARANTINED']);
      const ledger = (await c.query(
        `select transaction_type::text as t, facility_id = $2 as at_source, count(*)::int as n from public.transactions
         where transfer_id = $1 group by 1, 2 order by 1`, [transferId, n.fac.centreB])).rows;
      expect(ledger).toEqual([
        { t: 'INVENTORY_ACCEPTED', at_source: false, n: 2 },
        { t: 'INVENTORY_QUARANTINED', at_source: false, n: 1 },
        { t: 'INVENTORY_RESERVED', at_source: true, n: 3 },
        { t: 'TRANSFER_DISPATCHED', at_source: true, n: 3 },
        { t: 'TRANSFER_RECEIVED', at_source: false, n: 3 },
      ]);
      // Received-event ordering is preserved (RECEIVED precedes ACCEPTED/QUARANTINED for each unit).
      const order = (await c.query(
        `select to_status::text from public.transactions where inventory_unit_id = $1 order by occurred_at`, [units[1]])).rows.map((r) => r.to_status);
      expect(order).toEqual(['AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'RECEIVED', 'AVAILABLE']);
      expect(await scalar(c, `select count(distinct organization_id)::int from public.audit_logs where entity_id = $1 and action = 'transfer.receive'`,
        [transferId])).toBe(2);
    }));

  it('releases reserved units when an approved transfer is cancelled', () =>
    inRollback(c, async () => {
      const { n, transferId } = await proposed();
      await c.query(`select private.approve_transfer($1, $2, 2)`, [transferId, n.user.centreBAdmin]);
      await c.query(`select private.cancel_transfer($1, $2, 'no longer needed')`, [transferId, n.user.centreAAdmin]);
      expect(await scalar(c, `select count(*)::int from public.inventory_units u join public.transfer_items ti on ti.inventory_unit_id = u.id
        where ti.transfer_id = $1 and u.status = 'AVAILABLE'`, [transferId])).toBe(2);
    }));

  it('only destination admins/inventory managers can propose', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      await expectDbError(c, `insert into public.transfers (source_facility_id, destination_facility_id, blood_group_id, component_id,
          requested_quantity, initiated_by) values ($1, $2, $3, $4, 2, $5)`,
        [n.fac.centreB, n.fac.centreA, n.bg['O-'], n.comp.PRBC, n.user.drSharma], /initiator must be/);
    }));
});

describe('planning parameters (§3.26)', () => {
  it('resolves the most specific scope and errors when missing', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const key = `test.param.${Date.now()}`;
      await expectDbError(c, `select private.resolve_parameter($1, $2, $3, $4)`, [key, n.fac.centreA, n.bg['O-'], n.comp.PRBC], /not configured/);
      const add = (org: string | null, fac: string | null, bg: number | null, comp: number | null, v: number) =>
        c.query(`insert into public.planning_parameters (key, organization_id, facility_id, blood_group_id, component_id, value, description)
                 values ($1, $2, $3, $4, $5, to_jsonb($6::numeric), 'test')`, [key, org, fac, bg, comp, v]);
      const resolve = (bg: number) => scalar(c, `select private.resolve_parameter($1, $2, $3, $4)::text`, [key, n.fac.centreA, bg, n.comp.PRBC]);
      await add(null, null, null, null, 1);
      expect(await resolve(n.bg['O-'])).toBe('1');
      await add(n.org.abc, null, null, null, 2);
      expect(await resolve(n.bg['O-'])).toBe('2');
      await add(n.org.abc, n.fac.centreA, null, null, 3);
      expect(await resolve(n.bg['O-'])).toBe('3');
      await add(n.org.abc, n.fac.centreA, n.bg['O-'], n.comp.PRBC, 4);
      expect(await resolve(n.bg['O-'])).toBe('4');
      expect(await resolve(n.bg['A+'])).toBe('3');
      await expectDbError(c, `insert into public.planning_parameters (key, organization_id, facility_id, value, description)
        values ($1, $2, $3, '1', 'dup')`, [key, n.org.abc, n.fac.centreA], /planning_parameters_scope_unique/);
      await expectDbError(c, `insert into public.planning_parameters (key, organization_id, facility_id, value, description)
        values ($1, $2, $3, '"text"', 'bad')`, [`${key}.x`, n.org.abc, n.fac.centreA], /planning_parameters_value_check/);
    }));
});
