import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDemoRules, addUnits, buildNetwork, emergencyRequest, setHoldTimeout, type Network } from './fixtures.js';
import { applyMigrations, connect, isHosted, SHIM_SQL } from './harness.js';

/**
 * Real two-session concurrency (§6.5). Needs committed fixtures visible to both sessions, so it
 * runs only against the local throwaway database — never against hosted Supabase.
 */
const DB = 'bloodlink_concurrency';
let admin: pg.Client;
let a: pg.Client;
let b: pg.Client;
let n: Network;

describe.skipIf(isHosted())('concurrent sessions', () => {
  beforeAll(async () => {
    admin = await connect();
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    const setup = await connect(DB);
    await setup.query(SHIM_SQL);
    await applyMigrations(setup, { includeScheduledJobs: false });
    n = await buildNetwork(setup);
    await addDemoRules(setup, n);
    await setHoldTimeout(setup, n.org.cbc, n.fac.centreB, 15);
    await setup.end();
    a = await connect(DB);
    b = await connect(DB);
  });

  afterAll(async () => {
    await a?.end();
    await b?.end();
    await admin?.query(`drop database if exists ${DB}`);
    await admin?.end();
  });

  const place = (client: pg.Client, itemId: string, qty: number) =>
    client.query(`select private.place_source_hold($1, $2, $3, $4, true) as id`, [itemId, n.fac.centreB, qty, n.user.sunriseStaff]);

  const noUnitHeldTwice = async () => {
    const dup = await a.query(
      `select inventory_unit_id from public.request_allocations where status in ('RESERVED', 'CONFIRMED', 'DISPATCHED')
       group by 1 having count(*) > 1`);
    expect(dup.rows).toEqual([]);
  };

  it('gives two simultaneous emergency holds disjoint units without waiting', async () => {
    await addUnits(a, n, n.fac.centreB, 'O-', 4);
    const r1 = await emergencyRequest(a, n, 2);
    const r2 = await emergencyRequest(a, n, 2);

    await a.query('begin');
    const first = (await place(a, r1.itemId, 2)).rows.map((r) => r.id);   // session A holds row locks, uncommitted
    await b.query('begin');
    const second = (await place(b, r2.itemId, 2)).rows.map((r) => r.id);  // session B skips A's locked units
    await a.query('commit');
    await b.query('commit');

    const units = (await a.query(`select request_item_id, inventory_unit_id from public.request_allocations where id = any ($1)`,
      [[...first, ...second]])).rows;
    expect(new Set(units.map((u) => u.inventory_unit_id)).size).toBe(4);
    await noUnitHeldTwice();
  });

  it('fails the second request cleanly when the first has claimed the scarce units', async () => {
    await a.query(`select private.release_expired_holds()`);
    const unitsBefore = await addUnits(a, n, n.fac.centreB, 'O-', 3);
    // Take all other AVAILABLE O− units at Centre B out of play so exactly the new 3 are eligible.
    await a.query(`select private.transition_unit_status(id, 'WASTED') from public.inventory_units
      where facility_id = $1 and status = 'AVAILABLE' and not (id = any ($2))`, [n.fac.centreB, unitsBefore]);
    const r1 = await emergencyRequest(a, n, 2);
    const r2 = await emergencyRequest(a, n, 2);

    await a.query('begin');
    await place(a, r1.itemId, 2);
    await b.query('begin');
    const err = await place(b, r2.itemId, 2).then(() => null, (e: Error) => e);
    await b.query('rollback');
    await a.query('commit');

    expect(err?.message).toMatch(/insufficient units at this source \(1 of 2 available\)/);
    expect((await a.query(`select count(*)::int as n from public.request_allocations where request_item_id = $1`, [r2.itemId])).rows[0].n).toBe(0);
    await noUnitHeldTwice();
  });

  it('lets the release job skip a hold another session is confirming, then handle it once free', async () => {
    const unit = await addUnits(a, n, n.fac.centreB, 'O-', 1);
    const r = await emergencyRequest(a, n, 1);
    const [alloc] = (await place(a, r.itemId, 1)).rows.map((row) => row.id);
    await a.query(`select set_config('bloodlink.allocation_write', 'on', false)`);
    await a.query(`update public.request_allocations set hold_expires_at = now() - interval '1 minute' where id = $1`, [alloc]);
    await a.query(`select set_config('bloodlink.allocation_write', '', false)`);

    await a.query('begin');
    await a.query(`select 1 from public.request_allocations where id = $1 for update`, [alloc]); // confirm in progress
    const skipped = (await b.query(`select private.release_expired_holds($1) as n`, [n.fac.centreB])).rows[0].n;
    await a.query('rollback');
    const released = (await b.query(`select private.release_expired_holds($1) as n`, [n.fac.centreB])).rows[0].n;

    expect(skipped).toBe(0);
    expect(released).toBe(1);
    const state = (await a.query(`select a.status::text, u.status::text as unit from public.request_allocations a
      join public.inventory_units u on u.id = a.inventory_unit_id where a.id = $1`, [alloc])).rows[0];
    expect(state).toEqual({ status: 'EXPIRED', unit: 'AVAILABLE' });
    expect(unit).toHaveLength(1);
  });

  it('never assigns one unit to two concurrent transfer approvals', async () => {
    await a.query(`select private.transition_unit_status(id, 'WASTED') from public.inventory_units
      where facility_id = $1 and status = 'AVAILABLE'`, [n.fac.centreB]);
    await addUnits(a, n, n.fac.centreB, 'O-', 4);
    const propose = async () => (await a.query(
      `insert into public.transfers (source_facility_id, destination_facility_id, blood_group_id, component_id, requested_quantity, initiated_by)
       values ($1, $2, $3, $4, 3, $5) returning id`, [n.fac.centreB, n.fac.centreA, n.bg['O-'], n.comp.PRBC, n.user.centreAAdmin])).rows[0].id;
    const t1 = await propose();
    const t2 = await propose();

    await a.query('begin');
    await a.query(`select private.approve_transfer($1, $2, 3)`, [t1, n.user.centreBAdmin]);
    await b.query('begin');
    const err = await b.query(`select private.approve_transfer($1, $2, 3)`, [t2, n.user.centreBAdmin]).then(() => null, (e: Error) => e);
    await b.query('rollback');
    await a.query('commit');

    expect(err?.message).toMatch(/insufficient units at source \(1 of 3\)/);
    const dup = await a.query(`select inventory_unit_id from public.transfer_items group by 1 having count(*) > 1`);
    expect(dup.rows).toEqual([]);
  });
});
