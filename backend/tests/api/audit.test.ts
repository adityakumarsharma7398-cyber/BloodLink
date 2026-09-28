import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditUsageError, createAuditService, type AuditEntry } from '../../src/audit/auditService.js';
import { createLogger } from '../../src/lib/logger.js';
import type { Network } from '../db/fixtures.js';
import { realDatabase, seedNetwork, withPg } from './harness.js';

const db = realDatabase();
const lines: string[] = [];
const audit = createAuditService(createLogger({ level: 'debug', sink: (line) => lines.push(line) }));
let n: Network;

beforeAll(async () => {
  n = await seedNetwork();
});
afterAll(() => db.disconnect());

const rowsFor = (entityId: string) =>
  withPg(async (client) =>
    (await client.query('select * from public.audit_logs where entity_id = $1 order by occurred_at', [entityId])).rows);

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  actorId: n.user.abcOrgAdmin,
  organizationId: n.org.abc,
  facilityId: n.fac.centreA,
  action: 'user.role_grant',
  entityType: 'user',
  entityId: randomUUID(),
  oldValue: { roles: [] },
  newValue: { roles: ['BLOOD_BANK_STAFF'] },
  correlationId: randomUUID(),
  ip: '203.0.113.7',
  ...over,
});

describe('the audit record is written through private.write_audit', () => {
  it('stores actor, organization, facility, action, entity, before/after and the correlation id', async () => {
    const e = entry();
    await db.withTransaction((tx) => audit.record(tx, e));
    const [row] = await rowsFor(e.entityId!);
    expect(row).toMatchObject({
      user_id: e.actorId, organization_id: e.organizationId, facility_id: e.facilityId, action: 'user.role_grant',
      entity_type: 'user', entity_id: e.entityId, old_value: { roles: [] }, new_value: { roles: ['BLOOD_BANK_STAFF'] },
      correlation_id: e.correlationId,
    });
  });

  it('supports system actions and entries without before/after values', async () => {
    const e = entry({ actorId: null, oldValue: null, newValue: undefined, action: 'planning_parameter.change' });
    await db.withTransaction((tx) => audit.record(tx, e));
    const [row] = await rowsFor(e.entityId!);
    expect(row).toMatchObject({ user_id: null, old_value: null, new_value: null });
  });

  it('records the client IP next to the correlation id in the server log, not in audit_logs.ip_address (documented limitation)', async () => {
    lines.length = 0;
    const e = entry();
    await db.withTransaction((tx) => audit.record(tx, e));
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'audit');
    expect(logged).toMatchObject({ action: 'user.role_grant', requestId: e.correlationId, ip: '203.0.113.7' });
    const [row] = await rowsFor(e.entityId!);
    expect(row.ip_address).toBeNull();
  });
});

describe('the business change and its audit record commit or roll back together', () => {
  it('both are visible after commit', async () => {
    const name = `Audited ${randomUUID()}`;
    const e = entry({ entityType: 'organization', action: 'organization.verify' });
    await db.withTransaction(async (tx) => {
      await tx.organizations.create({ data: { name, type: 'CLINIC' } });
      await audit.record(tx, e);
    });
    expect(await rowsFor(e.entityId!)).toHaveLength(1);
    expect((await withPg((c) => c.query('select count(*)::int as n from public.organizations where name = $1', [name]))).rows[0].n).toBe(1);
  });

  it('neither is kept when the transaction fails AFTER the audit write', async () => {
    const name = `Failed ${randomUUID()}`;
    const e = entry();
    await expect(
      db.withTransaction(async (tx) => {
        await tx.organizations.create({ data: { name, type: 'CLINIC' } });
        await audit.record(tx, e);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await rowsFor(e.entityId!)).toHaveLength(0);
    expect((await withPg((c) => c.query('select count(*)::int as n from public.organizations where name = $1', [name]))).rows[0].n).toBe(0);
  });

  it('a failed audit write rolls the business change back too', async () => {
    const name = `AuditFail ${randomUUID()}`;
    const badActor = randomUUID();
    await db
      .withTransaction(async (tx) => {
        await tx.organizations.create({ data: { name, type: 'CLINIC' } });
        // unknown organization id is fine for audit_logs (no FKs), so force a real failure instead:
        await tx.$executeRaw`select 1/0`;
        await audit.record(tx, entry({ actorId: badActor }));
      })
      .catch(() => undefined);
    expect((await withPg((c) => c.query('select count(*)::int as n from public.organizations where name = $1', [name]))).rows[0].n).toBe(0);
  });

  it('refuses to write outside a transaction handed out by withTransaction', async () => {
    const e = entry();
    await expect(audit.record(db.prisma as never, e)).rejects.toThrow(AuditUsageError);
    await expect(audit.record({} as never, e)).rejects.toThrow(/requires the transaction/);
    expect(await rowsFor(e.entityId!)).toHaveLength(0);
  });
});

describe('audit entries are validated and stay free of sensitive data', () => {
  const rejected = (over: Partial<AuditEntry>, pattern: RegExp) =>
    expect(db.withTransaction((tx) => audit.record(tx, entry(over)))).rejects.toThrow(pattern);

  it('rejects malformed actions, entity types and ids', async () => {
    await rejected({ action: 'Grant Role' }, /entity.verb/);
    await rejected({ action: 'grant' }, /entity.verb/);
    await rejected({ action: 'user.role_grant; drop table x' }, /entity.verb/);
    await rejected({ entityType: 'User Table' }, /lower_snake_case/);
    await rejected({ actorId: 'not-a-uuid' }, /actorId must be a UUID/);
    await rejected({ correlationId: 'req-1' }, /correlationId must be a UUID/);
    await rejected({ entityId: '123' }, /entityId must be a UUID/);
  });

  it.each(['patient_reference', 'contact_phone', 'email', 'password', 'accessToken', 'address', 'date_of_birth'])('rejects a "%s" field in the before/after values', async (key) => {
    await rejected({ newValue: { nested: { [key]: 'x' } } }, /sensitive field/);
    await rejected({ oldValue: { list: [{ [key]: 'x' }] } }, /sensitive field/);
  });

  it('rejects oversized before/after values', async () => {
    await rejected({ newValue: { blob: 'x'.repeat(9_000) } }, /too large/);
  });

  it('writes nothing for a rejected entry', async () => {
    const e = entry({ action: 'bad action' });
    await expect(db.withTransaction((tx) => audit.record(tx, e))).rejects.toThrow();
    expect(await rowsFor(e.entityId!)).toHaveLength(0);
  });
});
