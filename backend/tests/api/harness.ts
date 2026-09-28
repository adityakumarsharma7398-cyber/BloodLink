import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase, type Database } from '../../src/db/client.js';
import { silentLogger } from '../../src/lib/logger.js';
import { buildNetwork, type Network } from '../db/fixtures.js';

/** The PRODUCTION createDatabase() (Prisma 7 + pg adapter) pointed at the local test database. */
export function realDatabase(url: string = inject('apiDbUrl')): Database {
  return createDatabase({ url, ssl: { mode: 'disable' }, poolMax: 5 }, silentLogger);
}

export async function withPg<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('apiDbUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Committed fixture network (ABC Hospital / Centre A / Centre B / Sunrise Clinic / Metro Hospital + users), unique per call. */
export const seedNetwork = (): Promise<Network> => withPg((client) => buildNetwork(client));

const USER_STATUS = 'user_status';
const ORG_STATUS = 'organization_status';

/** Sets a user/organization status directly (test setup only, against the throwaway database). */
export const setStatus = (table: 'users' | 'organizations', id: string, status: string) =>
  withPg((client) =>
    client.query(`update public.${table} set status = $2::text::public.${table === 'users' ? USER_STATUS : ORG_STATUS} where id = $1`, [id, status]),
  );

/** Creates auth.users + public.users (ACTIVE) in the throwaway database and returns the user id. */
export async function createUser(name: string, organizationId: string | null, facilityId: string | null): Promise<string> {
  const id = randomUUID();
  const email = `${name.toLowerCase()}.${id.slice(0, 8)}@test.bloodlink.invalid`;
  await withPg(async (client) => {
    await client.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
    await client.query(
      "insert into public.users (id, organization_id, facility_id, full_name, email, status) values ($1, $2, $3, $4, $5, 'ACTIVE')",
      [id, organizationId, facilityId, name, email],
    );
  });
  return id;
}

export const grantRole = (userId: string, role: string, organizationId: string | null, facilityId: string | null) =>
  withPg((client) =>
    client.query(
      'insert into public.user_roles (user_id, role_id, organization_id, facility_id) select $1, id, $3, $4 from public.roles where code = $2::text::public.app_role',
      [userId, role, organizationId, facilityId],
    ),
  );

export const revokeAllRoles = (userId: string) => withPg((client) => client.query('delete from public.user_roles where user_id = $1', [userId]));
