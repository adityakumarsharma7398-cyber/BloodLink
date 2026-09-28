import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './harness.js';

// Catalog checks — read-only, safe on hosted Supabase.
let c: pg.Client;
beforeAll(async () => {
  c = await connect();
});
afterAll(async () => {
  await c.end();
});

const rows = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

const EXPECTED_TABLES = [
  'alerts', 'audit_logs', 'blood_groups', 'compatibility_rules', 'components', 'donation_components', 'donations',
  'donor_activation_recipients', 'donor_activations', 'donors', 'facilities', 'inventory_units', 'organizations',
  'planning_parameters', 'predictions', 'recommendations', 'request_allocations', 'request_items', 'requests', 'roles',
  'storage_locations', 'transactions', 'transfer_items', 'transfers', 'user_roles', 'users',
];

describe('tables and enums', () => {
  it('creates exactly the 25 approved tables plus planning_parameters', async () => {
    const tables = (await rows(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    )).map((r) => r.table_name);
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('has no password column anywhere in public.users', async () => {
    const cols = (await rows(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'users'`,
    )).map((r) => r.column_name);
    expect(cols.some((col) => /pass/i.test(col))).toBe(false);
  });

  it('defines the ledger event enum as the 14 unit-lifecycle events only', async () => {
    const values = (await rows(`select unnest(enum_range(null::public.transaction_type))::text as v`)).map((r) => r.v);
    expect(values).toHaveLength(14);
    expect(values).not.toContain('REQUEST_FULFILLED');
    expect(values).not.toContain('DONATION_RECEIVED');
    expect(values).toEqual(expect.arrayContaining(['INVENTORY_DISPATCHED', 'INVENTORY_QUARANTINED', 'INVENTORY_ACCEPTED']));
  });

  it('keeps the 10 unit statuses and drops PROCUREMENT from prediction types', async () => {
    const status = (await rows(`select unnest(enum_range(null::public.inventory_unit_status))::text as v`)).map((r) => r.v);
    expect(status.sort()).toEqual(
      ['AVAILABLE', 'DISPATCHED', 'EXPIRED', 'IN_TRANSIT', 'ISSUED', 'QUARANTINED', 'RECEIVED', 'RESERVED', 'RETURNED', 'WASTED']);
    const types = (await rows(`select unnest(enum_range(null::public.prediction_type))::text as v`)).map((r) => r.v);
    expect(types).toEqual(['DEMAND', 'SHORTAGE', 'EXPIRY']);
  });

  it('keeps recommendation fields out of predictions (D3)', async () => {
    const cols = (await rows(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'predictions'`,
    )).map((r) => r.column_name);
    expect(cols).not.toContain('recommended_quantity');
    expect(cols).not.toContain('recommendation_type');
  });

  it('keeps transfer_items unit-level and quantities on transfers (D5)', async () => {
    const items = (await rows(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'transfer_items'`,
    )).map((r) => r.column_name);
    expect(items).not.toContain('quantity');
    expect(items).not.toContain('component_id');
    const transfer = (await rows(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'transfers'`,
    )).map((r) => r.column_name);
    expect(transfer).toEqual(expect.arrayContaining(['requested_quantity', 'approved_quantity']));
  });

  it('seeds only reference codes: no clinical values, no compatibility rules, no planning parameters', async () => {
    const comps = await rows(`select typical_storage_days, storage_temp_min, storage_temp_max, values_validation_status from public.components`);
    expect(comps).toHaveLength(4);
    for (const comp of comps) {
      expect(comp.typical_storage_days).toBeNull();
      expect(comp.storage_temp_min).toBeNull();
      expect(comp.storage_temp_max).toBeNull();
      expect(comp.values_validation_status).not.toBe('VALIDATED');
    }
    expect(Number((await rows(`select count(*) from public.compatibility_rules where validation_status = 'VALIDATED'`))[0].count)).toBe(0);
    expect((await rows(`select code from public.roles order by id`)).map((r) => r.code)).toHaveLength(10);
  });
});

describe('security posture', () => {
  it('enables RLS on every public table', async () => {
    const off = await rows(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(off).toEqual([]);
  });

  it('defines SELECT policies only — no browser write policy exists', async () => {
    const writes = await rows(`select tablename, policyname, cmd from pg_policies where schemaname = 'public' and cmd <> 'SELECT'`);
    expect(writes).toEqual([]);
  });

  it('gives anon and authenticated no write privilege on any table', async () => {
    const grants = await rows(
      `select grantee, table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon', 'authenticated')
         and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`);
    expect(grants).toEqual([]);
  });

  it('lets browser roles execute only the RLS helpers in the private schema', async () => {
    const executable = (await rows(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE') order by 1`,
    )).map((r) => r.proname);
    expect(executable).toEqual(['admin_org_ids', 'donor_id', 'facility_ids', 'is_super_admin', 'org_ids', 'served_request_ids']);
    const anon = await rows(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and has_function_privilege('anon', p.oid, 'EXECUTE')`);
    expect(anon).toEqual([]);
  });

  it('keeps summary views security_invoker so RLS applies through them', async () => {
    const views = await rows(
      `select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname in ('v_inventory_summary', 'v_daily_consumption')`);
    expect(views).toHaveLength(2);
    for (const v of views) expect(v.reloptions).toContain('security_invoker=true');
  });

  it('publishes the operational tables to Supabase Realtime', async () => {
    const published = (await rows(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1`,
    )).map((r) => r.tablename);
    expect(published).toEqual(expect.arrayContaining([
      'alerts', 'donor_activation_recipients', 'inventory_units', 'predictions', 'recommendations',
      'request_allocations', 'requests', 'transfers']));
  });

  it('links public.users to auth.users with ON DELETE RESTRICT (C11)', async () => {
    const fk = await rows(
      `select confdeltype from pg_constraint where conrelid = 'public.users'::regclass and contype = 'f'
         and confrelid = 'auth.users'::regclass`);
    expect(fk).toEqual([{ confdeltype: 'r' }]);
  });

  it('has the concurrency and one-current-row indexes', async () => {
    const idx = (await rows(`select indexname from pg_indexes where schemaname = 'public'`)).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining([
      'request_allocations_one_active_per_unit', 'predictions_one_current_per_series',
      'recommendations_one_pending_per_subject', 'inventory_units_available_fefo_idx', 'compatibility_rules_active_unique']));
  });
});
