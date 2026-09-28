import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { policy } from '../../src/authz/policy.js';
import { callPrivate } from '../../src/db/privateFunctions.js';
import type { Network } from '../db/fixtures.js';
import { buildGuardApp, stubTokenVerifier } from '../support/testApp.js';
import { realDatabase, seedNetwork, withPg } from './harness.js';

/** Real Prisma 7 / PostgreSQL errors, thrown from real queries, through the real error handler. */
const db = realDatabase();
const unreachable = realDatabase('postgres://nobody:secret-pw-zz@127.0.0.1:1/nowhere');
let n: Network;
let unitId: string;
let app: ReturnType<typeof buildGuardApp>;

const LEAKY = /prisma|select |insert |postgres|relation|constraint|blood_groups|127\.0\.0\.1|nowhere|secret-pw-zz|invocation|driver|P20\d\d|"public"/i;
const pub = policy.public({ rateLimit: false });

beforeAll(async () => {
  n = await seedNetwork();
  unitId = await withPg(async (client) => {
    const { rows } = await client.query(
      `select private.create_inventory_unit('ERR-' || gen_random_uuid()::text, $1::uuid, $2::smallint, $3::smallint,
         now() - interval '3 days', now() + interval '20 days', 'INVENTORY_ADDED', 'AVAILABLE', null) as id`,
      [n.fac.centreA, n.comp.PRBC, n.bg['O-']]);
    return rows[0].id as string;
  });

  app = buildGuardApp({ db, tokenVerifier: stubTokenVerifier() }, (secure) => {
    const t = secure('/e');
    t.get('/typed-unique', pub, async () => { await db.prisma.blood_groups.create({ data: { code: 'O-', display_name: 'x', is_known: false, sort_order: 99 } }); });
    t.get('/raw-unique', pub, async () => { await db.prisma.$executeRaw`insert into public.blood_groups (code, display_name, is_known, sort_order) values ('O-', 'x', false, 99)`; });
    t.get('/bad-uuid', pub, async () => { await db.prisma.$queryRaw`select 'not-a-uuid'::uuid`; });
    t.get('/typed-not-found', pub, async () => { await db.prisma.blood_groups.update({ where: { code: 'NOPE' }, data: { display_name: 'x' } }); });
    t.get('/fk', pub, async () => { await db.prisma.$executeRaw`insert into public.request_items (request_id, blood_group_id, component_id, quantity_requested) values (gen_random_uuid(), 1, 1, 1)`; });
    t.get('/check', pub, async () => { await db.prisma.$executeRaw`insert into public.blood_groups (code, display_name, is_known, sort_order, abo, rhd) values ('ZZ', 'x', true, 98, null, null)`; });
    t.get('/private-not-found', pub, async () => { await callPrivate(db.prisma, 'transition_unit_status', { p_unit: randomUUID(), p_to: 'WASTED' }); });
    t.get('/private-transition', pub, async () => { await callPrivate(db.prisma, 'transition_unit_status', { p_unit: unitId, p_to: 'IN_TRANSIT' }); });
    t.get('/private-privilege', pub, async () => {
      await callPrivate(db.prisma, 'network_availability', { p_actor: n.user.publicUser, p_recipient_group: n.bg['O-'], p_component: n.comp.PRBC, p_quantity: 1 });
    });
    t.get('/private-hold-missing', pub, async () => { await callPrivate(db.prisma, 'confirm_hold', { p_allocations: [randomUUID()], p_actor: n.user.centreBAdmin }); });
    t.get('/private-bad-arg', pub, async () => { await callPrivate(db.prisma, 'confirm_hold', { p_allocations: ['not-a-uuid'], p_actor: n.user.centreBAdmin }); });
    t.get('/timeout', pub, async () => {
      await db.withTransaction(async (tx) => {
        await tx.$executeRaw`set local statement_timeout = '150ms'`;
        await tx.$queryRaw`select pg_sleep(2)`;
      });
    });
    t.get('/rollback-conflict', pub, async () => {
      await db.withTransaction(async (tx) => {
        await tx.$executeRaw`insert into public.blood_groups (code, display_name, is_known, sort_order) values ('Q1', 'q', false, 97)`;
        await tx.$executeRaw`insert into public.blood_groups (code, display_name, is_known, sort_order) values ('Q1', 'q', false, 97)`;
      });
    });
    t.get('/unreachable', pub, async () => { await unreachable.prisma.blood_groups.findMany(); });
    t.get('/plain-throw', pub, async () => { throw new Error('SELECT secret FROM users WHERE token=eyJhbGciOi.abcdefghij.klmnopqrst'); });
  });
});
afterAll(async () => {
  await db.disconnect();
  await unreachable.disconnect();
});

const hit = (path: string) => request(app).get(`/e${path}`);

describe('database errors become safe, stable API errors', () => {
  it.each([
    ['/typed-unique', 409, 'CONFLICT'],
    ['/raw-unique', 409, 'CONFLICT'],
    ['/fk', 409, 'CONFLICT'],
    ['/check', 422, 'BUSINESS_RULE_VIOLATION'],
    ['/bad-uuid', 400, 'INVALID_ARGUMENT'],
    ['/typed-not-found', 404, 'NOT_FOUND'],
    ['/timeout', 503, 'DATABASE_TIMEOUT'],
    ['/rollback-conflict', 409, 'CONFLICT'],
  ])('%s → %i %s', async (path, status, code) => {
    const res = await hit(path);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(JSON.stringify(res.body)).not.toMatch(LEAKY);
  });

  it('a duplicate insert never reveals which key or column collided', async () => {
    const res = await hit('/raw-unique');
    expect(res.body.error).toEqual({ code: 'CONFLICT', message: 'That record already exists', requestId: expect.any(String) });
  });
});

describe('errors raised by BloodLink’s own database functions keep stable business codes', () => {
  it.each([
    ['/private-not-found', 404, 'NOT_FOUND'],
    ['/private-transition', 422, 'INVALID_UNIT_TRANSITION'],
    ['/private-privilege', 403, 'FORBIDDEN'],
    ['/private-hold-missing', 404, 'NOT_FOUND'],
  ])('%s → %i %s', async (path, status, code) => {
    const res = await hit(path);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toMatch(LEAKY);
    expect(JSON.stringify(res.body)).not.toContain(unitId);
  });

  it('argument validation happens before any SQL runs', async () => {
    const res = await hit('/private-bad-arg');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('failures that must not leak', () => {
  it('an unreachable database is a 503 DATABASE_UNAVAILABLE with no host, port, user or password', async () => {
    const res = await hit('/unreachable');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(LEAKY);
  });

  it('an unknown exception is an opaque 500', async () => {
    const res = await hit('/plain-throw');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: expect.any(String) });
  });
});

describe('transactions', () => {
  it('a failed statement inside withTransaction rolls the whole transaction back', async () => {
    await hit('/rollback-conflict');
    const left = await withPg((client) => client.query("select count(*)::int as n from public.blood_groups where code = 'Q1'"));
    expect(left.rows[0].n).toBe(0);
  });
});
