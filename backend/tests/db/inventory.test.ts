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

// The canonical transition table from proposal §11.1 (30 rows).
const CANONICAL: [string, string, string][] = [
  ['QUARANTINED', 'AVAILABLE', 'INVENTORY_ACCEPTED'], ['QUARANTINED', 'WASTED', 'INVENTORY_WASTED'],
  ['QUARANTINED', 'EXPIRED', 'INVENTORY_EXPIRED'], ['AVAILABLE', 'RESERVED', 'INVENTORY_RESERVED'],
  ['AVAILABLE', 'ISSUED', 'INVENTORY_ISSUED'], ['AVAILABLE', 'QUARANTINED', 'INVENTORY_QUARANTINED'],
  ['AVAILABLE', 'WASTED', 'INVENTORY_WASTED'], ['AVAILABLE', 'EXPIRED', 'INVENTORY_EXPIRED'],
  ['RESERVED', 'AVAILABLE', 'INVENTORY_RELEASED'], ['RESERVED', 'DISPATCHED', 'INVENTORY_DISPATCHED'],
  ['RESERVED', 'IN_TRANSIT', 'TRANSFER_DISPATCHED'], ['RESERVED', 'ISSUED', 'INVENTORY_ISSUED'],
  ['RESERVED', 'WASTED', 'INVENTORY_WASTED'], ['RESERVED', 'EXPIRED', 'INVENTORY_EXPIRED'],
  ['DISPATCHED', 'ISSUED', 'INVENTORY_ISSUED'], ['DISPATCHED', 'RETURNED', 'INVENTORY_RETURNED'],
  ['DISPATCHED', 'WASTED', 'INVENTORY_WASTED'], ['IN_TRANSIT', 'RECEIVED', 'TRANSFER_RECEIVED'],
  ['IN_TRANSIT', 'WASTED', 'INVENTORY_WASTED'], ['RECEIVED', 'AVAILABLE', 'INVENTORY_ACCEPTED'],
  ['RECEIVED', 'QUARANTINED', 'INVENTORY_QUARANTINED'], ['RECEIVED', 'WASTED', 'INVENTORY_WASTED'],
  ['RECEIVED', 'EXPIRED', 'INVENTORY_EXPIRED'], ['ISSUED', 'RETURNED', 'INVENTORY_RETURNED'],
  ['RETURNED', 'AVAILABLE', 'INVENTORY_ACCEPTED'], ['RETURNED', 'QUARANTINED', 'INVENTORY_QUARANTINED'],
  ['RETURNED', 'WASTED', 'INVENTORY_WASTED'],
];
const STATUSES = ['AVAILABLE', 'RESERVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'ISSUED', 'RETURNED', 'WASTED', 'EXPIRED', 'QUARANTINED'];

describe('canonical transition table', () => {
  it('maps exactly the approved pairs to their ledger events and rejects every other pair', async () => {
    const allowed = new Map(CANONICAL.map(([f, t, e]) => [`${f}>${t}`, e]));
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const event = await scalar<string | null>(c, `select private.transition_event($1, $2)::text`, [from, to]);
        expect(event, `${from} -> ${to}`).toBe(allowed.get(`${from}>${to}`) ?? null);
      }
    }
    // 27 status→status pairs + 3 creation events = the 30-row table in §11.1
    expect(CANONICAL).toHaveLength(27);
  });
});

describe('unit lifecycle enforcement', () => {
  it('creates units only through create_inventory_unit, with a creation ledger row', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const [unit] = await addUnits(c, n, n.fac.centreA, 'O-', 1);
      const tx = await one(c, `select transaction_type::text, from_status, to_status::text from public.transactions where inventory_unit_id = $1`, [unit]);
      expect(tx).toEqual({ transaction_type: 'INVENTORY_ADDED', from_status: null, to_status: 'AVAILABLE' });
      await expectDbError(c,
        `insert into public.inventory_units (unit_code, facility_id, component_id, blood_group_id, collection_date, expiry_date)
         values ('X-1', $1, $2, $3, now(), now() + interval '1 day')`,
        [n.fac.centreA, n.comp.PRBC, n.bg['O-']], /create_inventory_unit/);
    }));

  it('rejects direct status updates, invalid transitions and edits to identity fields', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const [unit] = await addUnits(c, n, n.fac.centreA, 'O-', 1);
      await expectDbError(c, `update public.inventory_units set status = 'ISSUED' where id = $1`, [unit], /transition_unit_status/);
      await expectDbError(c, `select private.transition_unit_status($1, 'IN_TRANSIT')`, [unit], /invalid unit transition AVAILABLE -> IN_TRANSIT/);
      await expectDbError(c, `update public.inventory_units set blood_group_id = $2 where id = $1`, [unit, n.bg['A+']], /immutable/);
    }));

  it('writes exactly one matching ledger row per transition and records the holding facility', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const [unit] = await addUnits(c, n, n.fac.centreA, 'O-', 1, { status: 'QUARANTINED' });
      for (const to of ['AVAILABLE', 'QUARANTINED', 'AVAILABLE', 'RESERVED', 'AVAILABLE', 'ISSUED', 'RETURNED', 'WASTED']) {
        await c.query(`select private.transition_unit_status($1, $2, $3)`, [unit, to, n.user.centreAAdmin]);
      }
      const ledger = (await c.query(
        `select from_status::text, to_status::text, transaction_type::text, facility_id from public.transactions
         where inventory_unit_id = $1 order by occurred_at, id`, [unit])).rows;
      expect(ledger).toHaveLength(9);
      const status = await scalar(c, `select status::text from public.inventory_units where id = $1`, [unit]);
      expect(ledger.at(-1)).toMatchObject({ to_status: status, transaction_type: 'INVENTORY_WASTED' });
      for (const row of ledger) expect(row.facility_id).toBe(n.fac.centreA);
      await expectDbError(c, `select private.transition_unit_status($1, 'AVAILABLE')`, [unit], /invalid unit transition WASTED/);
    }));

  it('keeps the ledger and audit log append-only', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const [unit] = await addUnits(c, n, n.fac.centreA, 'O-', 1);
      await expectDbError(c, `update public.transactions set note = 'x' where inventory_unit_id = $1`, [unit], /append-only/);
      await expectDbError(c, `delete from public.transactions where inventory_unit_id = $1`, [unit], /append-only/);
      await expectDbError(c, `insert into public.transactions (transaction_type, facility_id, inventory_unit_id, blood_group_id,
          component_id, from_status, to_status) values ('INVENTORY_WASTED', $1, $2, $3, $4, 'AVAILABLE', 'WASTED')`,
        [n.fac.centreA, unit, n.bg['O-'], n.comp.PRBC], /lifecycle functions/);
      await c.query(`insert into public.audit_logs (action, entity_type) values ('test.event', 'test')`);
      await expectDbError(c, `update public.audit_logs set action = 'x' where action = 'test.event'`, [], /append-only/);
      await expectDbError(c, `delete from public.audit_logs where action = 'test.event'`, [], /append-only/);
    }));

  it('derives inventory totals from units (v_inventory_summary)', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const units = await addUnits(c, n, n.fac.centreA, 'O-', 5);
      await addUnits(c, n, n.fac.centreA, 'O-', 2, { status: 'QUARANTINED' });
      await addUnits(c, n, n.fac.centreA, 'O-', 1, { expiresInDays: 3 });
      await c.query(`select private.transition_unit_status($1, 'RESERVED')`, [units[0]]);
      const s = await one(c,
        `select on_hand::int, usable::int, reserved::int, pending_acceptance::int, expiring_7d::int
         from public.v_inventory_summary where facility_id = $1 and blood_group_id = $2 and component_id = $3`,
        [n.fac.centreA, n.bg['O-'], n.comp.PRBC]);
      expect(s).toEqual({ on_hand: 8, usable: 5, reserved: 1, pending_acceptance: 2, expiring_7d: 1 });
    }));

  it('refuses inventory at a facility that does not hold inventory, and unknown blood groups', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      await expectDbError(c, `select private.create_inventory_unit('X-2', $1, $2, $3, now(), now() + interval '9 days',
          'INVENTORY_ADDED', 'AVAILABLE', null)`, [n.fac.abcHospital, n.comp.PRBC, n.bg['O-']], /does not hold inventory/);
      await expectDbError(c, `select private.create_inventory_unit('X-3', $1, $2, $3, now(), now() + interval '9 days',
          'INVENTORY_ADDED', 'AVAILABLE', null)`, [n.fac.centreA, n.comp.PRBC, n.bg.UNKNOWN], /known blood group/);
    }));

  it('expires past-expiry units idempotently', () =>
    inRollback(c, async () => {
      const n = await buildNetwork(c);
      const [unit] = await addUnits(c, n, n.fac.centreA, 'O-', 1, { expiresInDays: -3 });
      expect(await scalar(c, `select private.expire_units()`)).toBeGreaterThanOrEqual(1);
      expect(await scalar(c, `select status::text from public.inventory_units where id = $1`, [unit])).toBe('EXPIRED');
      expect(await scalar(c, `select count(*)::int from public.transactions where inventory_unit_id = $1 and transaction_type = 'INVENTORY_EXPIRED'`, [unit])).toBe(1);
      await c.query(`select private.expire_units()`);
      expect(await scalar(c, `select count(*)::int from public.transactions where inventory_unit_id = $1 and transaction_type = 'INVENTORY_EXPIRED'`, [unit])).toBe(1);
    }));
});
