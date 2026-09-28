import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { $Enums, PrismaClient } from '../../src/generated/prisma/client.js';
import { connect } from './harness.js';

// Prisma alignment: the generated client must match the database created by the SQL migrations.
let c: pg.Client;
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  c = await connect();
  const { user, password, host, port, database } = c;
  prisma = new PrismaClient({
    adapter: new PrismaPg({ user, password: String(password ?? ''), host, port, database }),
  });
});
afterAll(async () => {
  await prisma.$disconnect();
  await c.end();
});

describe('Prisma client alignment', () => {
  it('has a model for every public table (plus auth.users for the FK)', async () => {
    const tables = (await c.query(
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    )).rows.map((r) => r.table_name as string);
    const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
    const mapped = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
      name, db: /@@map\("(\w+)"\)/.exec(body!)?.[1] ?? name, schema: /@@schema\("(\w+)"\)/.exec(body!)?.[1] }));
    const publicModels = mapped.filter((m) => m.schema === 'public').map((m) => m.db).sort();
    expect(publicModels).toEqual(tables.sort());
    // Local stub has only auth.users; hosted Supabase adds its other Auth tables (read-only for the backend).
    expect(mapped.filter((m) => m.schema === 'auth')).toContainEqual({ name: 'auth_users', db: 'users', schema: 'auth' });
  });

  it('exposes every database enum with the same values', async () => {
    const dbEnums = (await c.query(
      `select t.typname, array_agg(e.enumlabel::text order by e.enumsortorder) as vals from pg_type t
       join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public' group by t.typname`,
    )).rows as { typname: string; vals: string[] }[];
    const prismaEnums = $Enums as unknown as Record<string, Record<string, string>>;
    expect(dbEnums).toHaveLength(36);
    for (const { typname, vals } of dbEnums) {
      expect(Object.values(prismaEnums[typname] ?? {}), typname).toEqual(vals);
    }
  });

  it('reads through the driver adapter against the migrated database', async () => {
    const groups = await prisma.blood_groups.findMany({ orderBy: { sort_order: 'asc' }, select: { code: true, is_known: true } });
    expect(groups.map((g) => g.code)).toEqual(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+', 'UNKNOWN']);
    expect(await prisma.roles.count()).toBe(10);
    expect(await prisma.compatibility_rules.count({ where: { validation_status: 'VALIDATED' } })).toBe(0);
  });

  it('cannot bypass the database guards (Prisma writes hit the same triggers)', async () => {
    await expect(prisma.transactions.deleteMany({ where: { note: '__never__' } })).resolves.toMatchObject({ count: 0 });
    await expect(prisma.audit_logs.create({ data: { action: 'prisma.test', entity_type: 'test' } })).resolves.toBeTruthy();
    await expect(prisma.audit_logs.deleteMany({ where: { action: 'prisma.test' } })).rejects.toThrow(/append-only/);
  });
});
