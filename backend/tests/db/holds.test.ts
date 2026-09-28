import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDemoRules, addUnits, buildNetwork, emergencyRequest, setHoldTimeout, type Network } from './fixtures.js';
import { connect, expectDbError, inRollback, one, scalar } from './harness.js';

// §6.5 source-context temporary reservation, confirmation, timeout and release.
let c: pg.Client;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.end();
});

async function setup() {
  const n = await buildNetwork(c);
  await addDemoRules(c, n);
  await setHoldTimeout(c, n.org.cbc, n.fac.centreB, 15);
  const units = await addUnits(c, n, n.fac.centreB, 'O-', 3);
  await addUnits(c, n, n.fac.centreB, 'O+', 2);
  const req = await emergencyRequest(c, n, 2);
  return { n, units, ...req };
}

const place = (itemId: string, n: Network, actor: string, qty = 2, demo = true) =>
  c.query(`select private.place_source_hold($1, $2, $3, $4, $5) as id`, [itemId, n.fac.centreB, qty, actor, demo]);

/** Test-only: move a hold's deadline into the past (simulates the timeout without waiting). */
const backdateHolds = (itemId: string) =>
  c.query(`select set_config('bloodlink.allocation_write', 'on', true);
           update public.request_allocations set hold_expires_at = now() - interval '1 minute' where request_item_id = '${itemId}';
           select set_config('bloodlink.allocation_write', '', true);`);

describe('placing a hold', () => {
  it('reserves compatible units first-expiry-first inside the source, with ledger and two-sided audit', () =>
    inRollback(c, async () => {
      const { n, units, itemId, requestId } = await setup();
      const allocs = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      expect(allocs).toHaveLength(2);

      const held = (await c.query(
        `select a.status::text, a.allocated_by, a.hold_expires_at > now() as future, u.id as unit, u.status::text as unit_status,
                u.blood_group_id, u.reserved_for_request_id
         from public.request_allocations a join public.inventory_units u on u.id = a.inventory_unit_id
         where a.id = any ($1) order by u.expiry_date`, [allocs])).rows;
      expect(held.map((h) => h.unit)).toEqual(units.slice(0, 2)); // earliest expiry first
      for (const h of held) {
        expect(h).toMatchObject({ status: 'RESERVED', allocated_by: n.user.sunriseStaff, future: true, unit_status: 'RESERVED',
          blood_group_id: n.bg['O-'], reserved_for_request_id: requestId });
      }
      const ledger = await one(c,
        `select count(*)::int as n, bool_and(recorded_by is null) as system, bool_and(facility_id = $2) as at_source
         from public.transactions where request_allocation_id = any ($1) and transaction_type = 'INVENTORY_RESERVED'`,
        [allocs, n.fac.centreB]);
      expect(ledger).toEqual({ n: 2, system: true, at_source: true });

      expect(await scalar(c, `select status::text from public.requests where id = $1`, [requestId])).toBe('ALLOCATED');
      const audits = (await c.query(
        `select action, organization_id, new_value ? 'unit_codes' as has_codes from public.audit_logs
         where entity_id = $1 and action like 'allocation.hold_%' order by action`, [requestId])).rows;
      expect(audits).toEqual([
        { action: 'allocation.hold_create', organization_id: n.org.cbc, has_codes: true },
        { action: 'allocation.hold_request', organization_id: n.org.sunrise, has_codes: false },
      ]);
    }));

  it('rejects public requesters, unrelated staff and the source-less backend path', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, true)`, [itemId, n.fac.centreB, n.user.publicUser], /not authorized/);
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, true)`, [itemId, n.fac.centreB, n.user.metroStaff], /not authorized/);
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, true)`, [itemId, n.fac.centreB, n.user.donorUser], /not authorized/);
    }));

  it('requires a VERIFIED request', () =>
    inRollback(c, async () => {
      const { n } = await setup();
      const pub = await one<{ id: string }>(c,
        `insert into public.requests (requester_user_id, patient_facility_id, request_type, urgency, required_by, contact_phone)
         values ($1, $2, 'EMERGENCY', 'CRITICAL', now() + interval '2 hours', '9999999999') returning id`,
        [n.user.publicUser, n.fac.sunrise]);
      const item = await one<{ id: string }>(c,
        `insert into public.request_items (request_id, blood_group_id, component_id, quantity_requested) values ($1, $2, $3, 1) returning id`,
        [pub.id, n.bg['O-'], n.comp.PRBC]);
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, true)`, [item.id, n.fac.centreB, n.user.sunriseStaff], /VERIFIED/);
      await expectDbError(c, `update public.requests set status = 'ALLOCATED' where id = $1`, [pub.id], /requests_verified_before_allocation/);
    }));

  it('never uses DEMO_ONLY rules unless explicitly allowed, and never incompatible units', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, false)`, [itemId, n.fac.centreB, n.user.sunriseStaff], /insufficient units/);
      // Only 3 O− exist; the O+ units are never used for an O− recipient.
      await expectDbError(c, `select private.place_source_hold($1, $2, 4, $3, true)`,
        [(await emergencyRequest(c, n, 4)).itemId, n.fac.centreB, n.user.sunriseStaff], /insufficient units at this source \(3 of 4 available\)/);
    }));

  it('is all-or-nothing, respects the remaining need and needs the source opt-in and timeout parameter', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      const big = await emergencyRequest(c, n, 5);
      await expectDbError(c, `select private.place_source_hold($1, $2, 5, $3, true)`, [big.itemId, n.fac.centreB, n.user.sunriseStaff], /insufficient units/);
      expect(await scalar(c, `select count(*)::int from public.request_allocations where request_item_id = $1`, [big.itemId])).toBe(0);
      await expectDbError(c, `select private.place_source_hold($1, $2, 3, $3, true)`, [itemId, n.fac.centreB, n.user.sunriseStaff], /exceeds the remaining need/);
      // Centre A has not configured a hold timeout → explicit error, no default.
      await addUnits(c, n, n.fac.centreA, 'O-', 2);
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, true)`, [itemId, n.fac.centreA, n.user.sunriseStaff], /not configured/);
      // Metro holds inventory but has not opted in to temporary holds.
      await expectDbError(c, `select private.place_source_hold($1, $2, 1, $3, true)`, [itemId, n.fac.metro, n.user.sunriseStaff], /does not accept temporary holds/);
    }));

  it('blocks every direct write to allocations, even from the backend role', () =>
    inRollback(c, async () => {
      const { n, itemId, units } = await setup();
      await expectDbError(c,
        `insert into public.request_allocations (request_item_id, inventory_unit_id, source_facility_id, allocated_by, hold_expires_at)
         values ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [itemId, units[0], n.fac.centreB, n.user.sunriseStaff], /private hold\/allocation functions/);
    }));
});

describe('confirmation, dispatch and issue', () => {
  it('requires source blood-bank staff to confirm before dispatch', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      const allocs = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      await expectDbError(c, `select private.dispatch_allocation($1, $2)`, [allocs, n.user.centreBStaff], /status conflict/);
      await expectDbError(c, `select private.confirm_hold($1, $2)`, [allocs, n.user.sunriseStaff], /only blood-bank staff of the source/);
      await expectDbError(c, `select private.confirm_hold($1, $2)`, [allocs, n.user.centreAAdmin], /only blood-bank staff of the source/);
      await c.query(`select private.confirm_hold($1, $2)`, [allocs, n.user.centreBStaff]);
      expect(await scalar(c, `select count(*)::int from public.request_allocations where id = any ($1) and status = 'CONFIRMED' and confirmed_by = $2`,
        [allocs, n.user.centreBStaff])).toBe(2);
    }));

  it('dispatches, issues and fulfils the request with the right ledger events', () =>
    inRollback(c, async () => {
      const { n, itemId, requestId } = await setup();
      const allocs = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      await c.query(`select private.confirm_hold($1, $2)`, [allocs, n.user.centreBStaff]);
      // Cross-organization: cannot jump from CONFIRMED straight to ISSUED.
      await expectDbError(c, `select private.issue_allocation($1, $2)`, [allocs, n.user.centreBStaff], /must be dispatched before issue/);
      await c.query(`select private.dispatch_allocation($1, $2)`, [allocs, n.user.centreBStaff]);
      await c.query(`select private.issue_allocation($1, $2)`, [allocs, n.user.centreBStaff]);
      const events = (await c.query(
        `select transaction_type::text as t, count(*)::int as n from public.transactions where request_allocation_id = any ($1)
         group by 1 order by 1`, [allocs])).rows;
      expect(events).toEqual([
        { t: 'INVENTORY_DISPATCHED', n: 2 }, { t: 'INVENTORY_ISSUED', n: 2 }, { t: 'INVENTORY_RESERVED', n: 2 }]);
      expect(await one(c, `select status::text, fulfilled_at is not null as done from public.requests where id = $1`, [requestId]))
        .toEqual({ status: 'FULFILLED', done: true });
      expect(await scalar(c, `select quantity_fulfilled from public.request_items where id = $1`, [itemId])).toBe(2);
      expect(await scalar(c, `select count(*)::int from public.audit_logs where entity_id = $1 and action = 'request.fulfil'`, [requestId])).toBe(1);
    }));

  it('lets the source decline and the requester cancel, releasing units', () =>
    inRollback(c, async () => {
      const { n, itemId, requestId } = await setup();
      const [a1, a2] = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      await expectDbError(c, `select private.decline_hold($1, $2, 'x')`, [[a1], n.user.sunriseStaff], /only blood-bank staff/);
      await c.query(`select private.decline_hold($1, $2, 'no courier available')`, [[a1], n.user.centreBAdmin]);
      await expectDbError(c, `select private.cancel_hold($1, $2, 'x')`, [[a2], n.user.metroStaff], /cannot cancel/);
      await c.query(`select private.cancel_hold($1, $2, 'patient transferred')`, [[a2], n.user.sunriseStaff]);
      const rows = (await c.query(
        `select a.status::text, a.cancel_reason, u.status::text as unit from public.request_allocations a
         join public.inventory_units u on u.id = a.inventory_unit_id where a.id = any ($1) order by a.cancel_reason`, [[a1, a2]])).rows;
      expect(rows).toEqual([
        { status: 'CANCELLED', cancel_reason: 'REQUESTER_CANCELLED', unit: 'AVAILABLE' },
        { status: 'CANCELLED', cancel_reason: 'SOURCE_DECLINED: no courier available', unit: 'AVAILABLE' },
      ]);
      expect(await scalar(c, `select status::text from public.requests where id = $1`, [requestId])).toBe('OPEN');

      // Privacy: the requester's free text never reaches anything the source organization can read.
      const sourceAudit = (await c.query(
        `select action, new_value from public.audit_logs where organization_id = $1 and entity_id = $2
           and action in ('allocation.cancel', 'allocation.decline') order by action`, [n.org.cbc, requestId])).rows;
      expect(sourceAudit).toHaveLength(2);
      for (const row of sourceAudit) {
        expect(Object.keys(row.new_value).sort()).toEqual(['quantity', 'reason_code', 'request_id', 'request_item_id', 'source_facility_id']);
        expect(row.new_value).toMatchObject({ request_id: requestId, request_item_id: itemId, source_facility_id: n.fac.centreB, quantity: 1 });
      }
      expect(sourceAudit.map((r) => r.new_value.reason_code)).toEqual(['REQUESTER_CANCELLED', 'SOURCE_DECLINED']);
      const sourceVisible = JSON.stringify([
        sourceAudit,
        (await c.query(`select cancel_reason from public.request_allocations where id = $1`, [a2])).rows,
        (await c.query(`select note from public.transactions where request_allocation_id = $1`, [a2])).rows,
      ]);
      expect(sourceVisible).not.toContain('patient transferred');
      // …and stays with the requesting organization.
      expect(await scalar(c, `select new_value->>'reason' from public.audit_logs where organization_id = $1 and entity_id = $2
        and action = 'allocation.cancel'`, [n.org.sunrise, requestId])).toBe('patient transferred');

      // Same principle in reverse: the source's decline text stays with the source only.
      const requesterDecline = (await c.query(
        `select new_value from public.audit_logs where organization_id = $1 and entity_id = $2 and action = 'allocation.decline'`,
        [n.org.sunrise, requestId])).rows;
      expect(requesterDecline).toEqual([{ new_value: { source_facility_id: n.fac.centreB, reason_code: 'SOURCE_DECLINED' } }]);
      const requesterVisible = JSON.stringify((await c.query(
        `select new_value from public.audit_logs where organization_id = $1 and entity_id = $2`, [n.org.sunrise, requestId])).rows);
      expect(requesterVisible).not.toContain('no courier available');
      expect(await scalar(c, `select note from public.transactions where request_allocation_id = $1 and transaction_type = 'INVENTORY_RELEASED'`, [a1])).toBe('no courier available');
      expect(await scalar(c, `select cancel_reason from public.request_allocations where id = $1`, [a1])).toBe('SOURCE_DECLINED: no courier available');
    }));
});

describe('timeout release', () => {
  it('expires overdue holds, releases units with a ledger event, and is idempotent', () =>
    inRollback(c, async () => {
      const { n, itemId, requestId } = await setup();
      const allocs = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      await backdateHolds(itemId);
      expect(await scalar(c, `select private.release_expired_holds($1)`, [n.fac.centreB])).toBe(2);
      const rows = (await c.query(
        `select a.status::text, a.cancel_reason, u.status::text as unit, u.reserved_for_request_id from public.request_allocations a
         join public.inventory_units u on u.id = a.inventory_unit_id where a.id = any ($1)`, [allocs])).rows;
      for (const r of rows) expect(r).toEqual({ status: 'EXPIRED', cancel_reason: 'CONFIRMATION_TIMEOUT', unit: 'AVAILABLE', reserved_for_request_id: null });
      expect(await scalar(c, `select count(*)::int from public.transactions where request_allocation_id = any ($1)
        and transaction_type = 'INVENTORY_RELEASED' and recorded_by is null`, [allocs])).toBe(2);
      expect(await scalar(c, `select status::text from public.requests where id = $1`, [requestId])).toBe('OPEN');
      expect(await scalar(c, `select count(*)::int from public.audit_logs where action = 'allocation.hold_expire' and user_id is null
        and organization_id in ($1, $2)`, [n.org.cbc, n.org.sunrise])).toBeGreaterThanOrEqual(2);
      expect(await scalar(c, `select count(*)::int from public.audit_logs where action = 'allocation.hold_expire'
        and organization_id = $1 and entity_id = $2 and new_value->>'reason_code' = 'CONFIRMATION_TIMEOUT'
        and new_value->>'request_item_id' = $3`, [n.org.cbc, requestId, itemId])).toBe(2);
      expect(await scalar(c, `select private.release_expired_holds($1)`, [n.fac.centreB])).toBe(0); // idempotent
    }));

  it('refuses confirmation after the deadline even before the job has run', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      const allocs = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      await backdateHolds(itemId);
      await expectDbError(c, `select private.confirm_hold($1, $2)`, [allocs, n.user.centreBStaff], /hold has expired/);
    }));

  it('never expires a confirmed hold', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      const allocs = (await place(itemId, n, n.user.sunriseStaff)).rows.map((r) => r.id);
      await c.query(`select private.confirm_hold($1, $2)`, [allocs, n.user.centreBStaff]);
      await backdateHolds(itemId);
      expect(await scalar(c, `select private.release_expired_holds()`)).toBe(0);
      expect(await scalar(c, `select count(*)::int from public.request_allocations where id = any ($1) and status = 'CONFIRMED'`, [allocs])).toBe(2);
    }));

  it('releases expired holds at the source when a new hold is placed (job delayed)', () =>
    inRollback(c, async () => {
      const { n, itemId } = await setup();
      await place(itemId, n, n.user.sunriseStaff, 2);
      await backdateHolds(itemId);
      // Only 3 O− units: the new request can get 3 only because the 2 expired holds are released first.
      const second = await emergencyRequest(c, n, 3);
      const allocs = (await place(second.itemId, n, n.user.sunriseStaff, 3)).rows;
      expect(allocs).toHaveLength(3);
      expect(await scalar(c, `select count(*)::int from public.request_allocations where request_item_id = $1 and status = 'EXPIRED'`, [itemId])).toBe(2);
    }));
});

describe('issued-unit code visibility (U7)', () => {
  async function issued() {
    const ctx = await setup();
    const allocs = (await place(ctx.itemId, ctx.n, ctx.n.user.sunriseStaff)).rows.map((r) => r.id);
    return { ...ctx, allocs };
  }

  it('shows nothing before issue, and bag codes only to request participants after issue', () =>
    inRollback(c, async () => {
      const { n, requestId, allocs } = await issued();
      const view = (actor: string) => c.query(`select * from private.issued_unit_codes($1, $2)`, [requestId, actor]);
      expect((await view(n.user.sunriseStaff)).rows).toEqual([]);

      await c.query(`select private.confirm_hold($1, $2)`, [allocs, n.user.centreBStaff]);
      await c.query(`select private.dispatch_allocation($1, $2)`, [allocs, n.user.centreBStaff]);
      await c.query(`select private.issue_allocation($1, $2)`, [allocs, n.user.centreBStaff]);

      const rows = (await view(n.user.sunriseStaff)).rows;
      expect(rows).toHaveLength(2);
      expect(Object.keys(rows[0]).sort()).toEqual(['blood_group', 'component', 'issued_at', 'request_number', 'unit_code']);
      expect((await view(n.user.centreBStaff)).rows).toHaveLength(2); // source: own units

      for (const outsider of [n.user.publicUser, n.user.donorUser, n.user.metroStaff, n.user.drSharma]) {
        await expectDbError(c, `select * from private.issued_unit_codes($1, $2)`, [requestId, outsider], /not a participant/);
      }
      expect(await scalar(c, `select count(*)::int from public.audit_logs where action = 'request.view_issued_units' and entity_id = $1`, [requestId]))
        .toBeGreaterThanOrEqual(3);
    }));
});
