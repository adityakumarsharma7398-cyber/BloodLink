import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isTransactionClient } from '../../src/db/client.js';
import { callPrivate, callPrivateScalar, PRIVATE_FUNCTIONS, type PrivateFunctionName } from '../../src/db/privateFunctions.js';
import { mapError } from '../../src/http/errorMapper.js';
import type { Network } from '../db/fixtures.js';
import { realDatabase, seedNetwork, withPg } from './harness.js';

const db = realDatabase();
let n: Network;

beforeAll(async () => {
  n = await seedNetwork();
});
afterAll(() => db.disconnect());

const orgCount = (name: string) =>
  withPg(async (client) => (await client.query('select count(*)::int as n from public.organizations where name = $1', [name])).rows[0].n as number);

describe('withTransaction', () => {
  it('commits when the function resolves', async () => {
    const name = `Committed ${randomUUID()}`;
    await db.withTransaction(async (tx) => {
      await tx.organizations.create({ data: { name, type: 'HOSPITAL' } });
    });
    expect(await orgCount(name)).toBe(1);
  });

  it('rolls back everything when the function throws', async () => {
    const name = `Rolled back ${randomUUID()}`;
    await expect(
      db.withTransaction(async (tx) => {
        await tx.organizations.create({ data: { name, type: 'HOSPITAL' } });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(await orgCount(name)).toBe(0);
  });

  it('hands out registered transaction clients only', async () => {
    expect(isTransactionClient(db.prisma)).toBe(false);
    expect(isTransactionClient({})).toBe(false);
    await db.withTransaction(async (tx) => {
      expect(isTransactionClient(tx)).toBe(true);
    });
  });

  it('reads its own writes and isolates concurrent transactions until commit', async () => {
    const name = `Isolated ${randomUUID()}`;
    await db.withTransaction(async (tx) => {
      await tx.organizations.create({ data: { name, type: 'CLINIC' } });
      expect(await tx.organizations.count({ where: { name } })).toBe(1);
      expect(await orgCount(name)).toBe(0); // not visible outside yet
    });
    expect(await orgCount(name)).toBe(1);
  });
});

describe('probe', () => {
  it('reports the database as reachable with a latency', async () => {
    const result = await db.probe();
    expect(result).toEqual({ ok: true, latencyMs: expect.any(Number) });
  });

  it('reports NOT_CONFIGURED without a URL and UNREACHABLE for a dead server, without throwing', async () => {
    const none = realDatabase('postgres://x:y@127.0.0.1:1/z');
    expect(await none.probe(2_000)).toEqual({ ok: false, reason: 'UNREACHABLE' });
    await none.disconnect();
    const unconfigured = (await import('../../src/db/client.js')).createDatabase(
      { ssl: { mode: 'disable' }, poolMax: 1 },
      (await import('../../src/lib/logger.js')).silentLogger,
    );
    expect(await unconfigured.probe()).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    await unconfigured.disconnect();
  });

  it('reports TIMEOUT (not UNREACHABLE) when the query is still pending when the deadline passes', async () => {
    // A real, reachable connection: the query would succeed given any realistic amount of time, but
    // an unreasonably tight deadline (1ms) forces the probe's own race to win, exactly the failure
    // mode a cold/slow connection produces if the probe's timeout is too short (the incident this
    // guards against).
    expect(await db.probe(1)).toEqual({ ok: false, reason: 'TIMEOUT' });
  });
});

describe('private function registry matches the live database catalog', () => {
  // registry type → what format_type() prints
  const DB_TYPE: Record<string, string> = { timestamptz: 'timestamp with time zone' };
  const norm = (type: string) => DB_TYPE[type.replace('public.', '')] ?? type.replace('public.', '');

  it.each(Object.keys(PRIVATE_FUNCTIONS) as PrivateFunctionName[])('private.%s: parameter names, types and required-ness', async (name) => {
    const rows = await withPg(async (client) =>
      (await client.query(
        `select p.pronargs::int as nargs, p.pronargdefaults::int as ndefaults, p.proargnames[1:p.pronargs] as names,
                (select array_agg(format_type(t, null) order by ord) from unnest(p.proargtypes) with ordinality as u(t, ord)) as types
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'private' and p.proname = $1`, [name])).rows);
    expect(rows, `private.${name} must exist exactly once`).toHaveLength(1);
    const row = rows[0] as { nargs: number; ndefaults: number; names: string[] | null; types: string[] };
    const spec = Object.entries(PRIVATE_FUNCTIONS[name].params) as [string, { type: string; required?: true }][];

    expect(spec.map(([param]) => param)).toEqual(row.names ?? []);
    expect(spec.map(([, { type }]) => norm(type))).toEqual((row.types ?? []).map(norm));
    const requiredCount = row.nargs - row.ndefaults;
    expect(spec.map(([, { required }], index) => (required ? index : -1)).filter((i) => i >= 0)).toEqual(
      Array.from({ length: requiredCount }, (_, i) => i),
    );
  });
});

describe('callPrivate', () => {
  it('rejects unknown functions and unknown parameters before touching the database', async () => {
    await expect(callPrivate(db.prisma, 'drop_everything' as never, {} as never)).rejects.toThrow(/Unknown private function/);
    await expect(callPrivate(db.prisma, '__proto__' as never, {} as never)).rejects.toThrow(/Unknown private function/);
    await expect(callPrivate(db.prisma, 'expire_units', { p_bogus: 1 } as never)).rejects.toThrow(/Unknown parameter/);
  });

  it('validates required arguments and types', async () => {
    const bad = (args: object) => callPrivate(db.prisma, 'approve_transfer', args as never);
    await expect(bad({})).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    await expect(bad({ p_transfer: 'x', p_actor: randomUUID(), p_approved_quantity: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(bad({ p_transfer: randomUUID(), p_actor: randomUUID(), p_approved_quantity: 1.5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(callPrivate(db.prisma, 'confirm_hold', { p_allocations: [], p_actor: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(callPrivate(db.prisma, 'confirm_hold', { p_allocations: ['nope'], p_actor: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(callPrivate(db.prisma, 'write_audit', { p_action: 'a.b', p_entity_type: 'x', p_old: 'not json object' } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('runs scalar functions and returns their value', async () => {
    // other test files share this database, so only the type and non-negativity are asserted here
    const expired = await callPrivateScalar(db.prisma, 'expire_units', {});
    expect(Number.isInteger(expired) && (expired as number) >= 0).toBe(true);
    expect(await callPrivateScalar(db.prisma, 'release_expired_holds', {})).toBe(0);
    expect(await callPrivateScalar(db.prisma, 'release_expired_holds', { p_source: n.fac.centreB })).toBe(0);
  });

  it('binds every value as a parameter: SQL-looking text is stored literally, never executed', async () => {
    const evil = "X'); drop table public.inventory_units; --";
    const [created] = await callPrivate(db.prisma, 'create_inventory_unit', {
      p_unit_code: evil, p_facility: n.fac.centreA, p_component: n.comp.PRBC, p_blood_group: n.bg['O-'],
      p_collection_date: new Date(Date.now() - 3 * 864e5), p_expiry_date: '2099-01-01T00:00:00Z',
      p_event: 'INVENTORY_ADDED', p_initial_status: 'AVAILABLE', p_actor: n.user.centreAAdmin, p_note: "it's a note",
    });
    const unitId = Object.values(created!)[0] as string;
    const stored = await withPg(async (client) => (await client.query('select unit_code, status::text from public.inventory_units where id = $1', [unitId])).rows[0]);
    expect(stored).toEqual({ unit_code: evil, status: 'AVAILABLE' });
    const table = await withPg(async (client) => (await client.query("select to_regclass('public.inventory_units') is not null as ok")).rows[0]);
    expect(table.ok).toBe(true);
  });

  it('passes timestamps, enums, optional arguments and defaults correctly, and returns ledger ids', async () => {
    const [unit] = await callPrivate(db.prisma, 'create_inventory_unit', {
      p_unit_code: `CP-${randomUUID()}`, p_facility: n.fac.centreA, p_component: n.comp.PRBC, p_blood_group: n.bg['O+'],
      p_collection_date: new Date(Date.now() - 864e5), p_expiry_date: new Date(Date.now() + 30 * 864e5),
      p_event: 'INVENTORY_ADDED', p_initial_status: 'QUARANTINED', p_actor: null,
    });
    const id = Object.values(unit!)[0] as string;
    const ledgerId = await callPrivateScalar(db.prisma, 'transition_unit_status', { p_unit: id, p_to: 'AVAILABLE', p_actor: n.user.centreAAdmin });
    expect(typeof ledgerId).toBe('string');
    const ledger = await withPg(async (client) =>
      (await client.query('select transaction_type::text as t, from_status::text as f, to_status::text as s, recorded_by from public.transactions where id = $1', [ledgerId])).rows[0]);
    expect(ledger).toEqual({ t: 'INVENTORY_ACCEPTED', f: 'QUARANTINED', s: 'AVAILABLE', recorded_by: n.user.centreAAdmin });
  });

  it('serialises uuid[] arguments (the function is reached and reports the missing allocation)', async () => {
    const error = await callPrivate(db.prisma, 'confirm_hold', { p_allocations: [randomUUID(), randomUUID()], p_actor: n.user.centreBAdmin }).catch((e: unknown) => e);
    expect(mapError(error)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('table-returning functions return rows', async () => {
    const rows = await callPrivate(db.prisma, 'network_availability', { p_actor: n.user.sunriseStaff, p_recipient_group: n.bg['O-'], p_component: n.comp.PRBC, p_quantity: 1 });
    expect(Array.isArray(rows)).toBe(true); // no forecasts / reserve floors configured → no facility is offered
    expect(rows).toEqual([]);
  });

  it('can only be used through a role that the database allows (no shortcut around the database checks)', async () => {
    const error = await callPrivate(db.prisma, 'network_availability', { p_actor: n.user.publicUser, p_recipient_group: n.bg['O-'], p_component: n.comp.PRBC, p_quantity: 1 }).catch((e: unknown) => e);
    expect(mapError(error)).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
});
