import { Prisma } from '../generated/prisma/client.js';
import { isUuid } from '../lib/ids.js';
import { HttpError } from '../utils/httpError.js';
import type { DbClient } from './client.js';

/**
 * Typed access to the backend-only functions in the database's `private` schema (migrations
 * 003–005). These functions are SECURITY DEFINER, re-check every precondition inside the database,
 * and are executable only by the backend's database role — never by anon/authenticated browsers.
 *
 * SAFETY:
 *  - The function name and parameter names/types come ONLY from this registry (never from a request),
 *    so nothing user-controlled is ever interpolated into SQL text.
 *  - Values are always bound parameters.
 *  - Named notation (`p_x => $1`) lets the database apply its own defaults for omitted parameters.
 *  - tests/api/database.test.ts verifies this registry against the live pg_proc catalog.
 *
 * Calling a function here does NOT replace authorization: callers must authorize first (src/authz).
 */

export type SqlType =
  | 'uuid' | 'uuid[]' | 'text' | 'integer' | 'smallint' | 'boolean' | 'jsonb' | 'timestamptz'
  | 'public.transaction_type' | 'public.inventory_unit_status';

interface ParamSpec {
  readonly type: SqlType;
  readonly required?: true;
}
interface FunctionSpec {
  readonly returns: 'scalar' | 'setof' | 'table' | 'void';
  readonly params: Readonly<Record<string, ParamSpec>>;
}

const uuid = { type: 'uuid' } as const;
const uuidReq = { type: 'uuid', required: true } as const;
const uuids = { type: 'uuid[]', required: true } as const;
const text = { type: 'text' } as const;
const textReq = { type: 'text', required: true } as const;
const int = { type: 'integer' } as const;
const intReq = { type: 'integer', required: true } as const;
const smallReq = { type: 'smallint', required: true } as const;
const bool = { type: 'boolean' } as const;
const ts = { type: 'timestamptz' } as const;

export const PRIVATE_FUNCTIONS = {
  // Unit lifecycle (003)
  create_inventory_unit: {
    returns: 'scalar',
    params: {
      p_unit_code: textReq, p_facility: uuidReq, p_component: smallReq, p_blood_group: smallReq,
      p_collection_date: { type: 'timestamptz', required: true }, p_expiry_date: { type: 'timestamptz', required: true },
      p_event: { type: 'public.transaction_type', required: true },
      p_initial_status: { type: 'public.inventory_unit_status', required: true },
      p_actor: uuidReq, p_donation: uuid, p_processing_date: ts, p_volume_ml: int, p_storage_location: uuid, p_note: text,
    },
  },
  transition_unit_status: {
    returns: 'scalar',
    params: {
      p_unit: uuidReq, p_to: { type: 'public.inventory_unit_status', required: true }, p_actor: uuid, p_to_facility: uuid,
      p_allocation: uuid, p_transfer: uuid, p_counterpart: uuid, p_reserved_for_request: uuid, p_note: text,
    },
  },
  // Source-context holds and allocations (004, §6.5)
  place_source_hold: {
    returns: 'setof',
    params: {
      p_request_item: uuidReq, p_source_facility: uuidReq, p_quantity: intReq, p_actor: uuidReq,
      p_allow_demo_rules: bool, p_recommendation: uuid, p_correlation: uuid,
    },
  },
  confirm_hold: { returns: 'scalar', params: { p_allocations: uuids, p_actor: uuidReq, p_correlation: uuid } },
  decline_hold: { returns: 'scalar', params: { p_allocations: uuids, p_actor: uuidReq, p_reason: textReq, p_correlation: uuid } },
  cancel_hold: { returns: 'scalar', params: { p_allocations: uuids, p_actor: uuidReq, p_reason: textReq, p_correlation: uuid } },
  dispatch_allocation: { returns: 'scalar', params: { p_allocations: uuids, p_actor: uuidReq, p_correlation: uuid } },
  issue_allocation: { returns: 'scalar', params: { p_allocations: uuids, p_actor: uuidReq, p_correlation: uuid } },
  return_allocation: { returns: 'scalar', params: { p_allocations: uuids, p_actor: uuidReq, p_reason: textReq, p_correlation: uuid } },
  release_expired_holds: { returns: 'scalar', params: { p_source: uuid } },
  issued_unit_codes: { returns: 'table', params: { p_request: uuidReq, p_actor: uuidReq, p_correlation: uuid } },
  // Transfers (004, §6.4)
  approve_transfer: { returns: 'scalar', params: { p_transfer: uuidReq, p_actor: uuidReq, p_approved_quantity: intReq, p_correlation: uuid } },
  reject_transfer: { returns: 'void', params: { p_transfer: uuidReq, p_actor: uuidReq, p_reason: textReq, p_correlation: uuid } },
  dispatch_transfer: { returns: 'scalar', params: { p_transfer: uuidReq, p_actor: uuidReq, p_correlation: uuid } },
  receive_transfer: { returns: 'scalar', params: { p_transfer: uuidReq, p_actor: uuidReq, p_rejected_units: { type: 'uuid[]' }, p_correlation: uuid } },
  cancel_transfer: { returns: 'void', params: { p_transfer: uuidReq, p_actor: uuidReq, p_reason: textReq, p_correlation: uuid } },
  expire_units: { returns: 'scalar', params: {} },
  // Audit (004) and network aggregate (005, §10.3)
  write_audit: {
    returns: 'void',
    params: {
      // No SQL defaults: every argument must be passed (null is allowed where the column is nullable).
      p_actor: uuidReq, p_organization: uuidReq, p_facility: uuidReq, p_action: textReq, p_entity_type: textReq,
      p_entity_id: uuidReq, p_old: { type: 'jsonb', required: true }, p_new: { type: 'jsonb', required: true }, p_correlation: uuidReq,
    },
  },
  network_availability: {
    returns: 'table',
    params: {
      p_actor: uuidReq, p_recipient_group: smallReq, p_component: smallReq, p_quantity: intReq,
      p_allow_substitutes: bool, p_allow_demo_rules: bool,
    },
  },
} as const satisfies Record<string, FunctionSpec>;

export type PrivateFunctionName = keyof typeof PRIVATE_FUNCTIONS;
type ParamsOf<N extends PrivateFunctionName> = (typeof PRIVATE_FUNCTIONS)[N]['params'];
type RequiredKeys<N extends PrivateFunctionName> = {
  [K in keyof ParamsOf<N>]: ParamsOf<N>[K] extends { required: true } ? K : never;
}[keyof ParamsOf<N>];

export type SqlValue = string | number | boolean | null | Date | readonly string[] | Readonly<Record<string, unknown>> | readonly unknown[];
export type PrivateArgs<N extends PrivateFunctionName> = { [K in RequiredKeys<N>]: SqlValue } & {
  [K in Exclude<keyof ParamsOf<N>, RequiredKeys<N>>]?: SqlValue;
};

const invalid = (message: string) => new HttpError(400, message, 'INVALID_ARGUMENT');
const ENUM_VALUE = /^[A-Z][A-Z_]{1,40}$/;
const MAX_TEXT = 4_000;

/** Validates a value for its declared SQL type and returns the bound-parameter form + cast. */
function bind(name: string, type: SqlType, value: SqlValue): Prisma.Sql {
  const cast = Prisma.raw(type);
  if (value === null) return Prisma.sql`${null}::${cast}`;
  switch (type) {
    case 'uuid':
      if (!isUuid(value)) throw invalid(`${name} must be a UUID`);
      return Prisma.sql`${value}::${cast}`;
    case 'uuid[]': {
      if (!Array.isArray(value) || value.length === 0 || value.length > 500 || !value.every(isUuid)) {
        throw invalid(`${name} must be a non-empty list of UUIDs`);
      }
      return Prisma.sql`${value as string[]}::${cast}`;
    }
    case 'integer':
    case 'smallint':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(`${name} must be an integer`);
      return Prisma.sql`${value}::${cast}`;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(`${name} must be a boolean`);
      return Prisma.sql`${value}::${cast}`;
    case 'text':
      if (typeof value !== 'string' || value.length > MAX_TEXT) throw invalid(`${name} must be text of at most ${MAX_TEXT} characters`);
      return Prisma.sql`${value}::${cast}`;
    case 'jsonb':
      if (typeof value !== 'object') throw invalid(`${name} must be a JSON object or array`);
      return Prisma.sql`${JSON.stringify(value)}::${cast}`;
    case 'timestamptz': {
      const date = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(date.getTime())) throw invalid(`${name} must be a valid timestamp`);
      return Prisma.sql`${date.toISOString()}::${cast}`;
    }
    default:
      if (typeof value !== 'string' || !ENUM_VALUE.test(value)) throw invalid(`${name} must be an enum value`);
      return Prisma.sql`${value}::${cast}`;
  }
}

/**
 * Calls `private.<name>(...)` and returns its rows. Use inside `withTransaction` whenever the call
 * is part of a business mutation, so the mutation and its audit record commit or roll back together.
 */
export async function callPrivate<N extends PrivateFunctionName>(
  db: DbClient,
  name: N,
  args: PrivateArgs<N>,
): Promise<Record<string, unknown>[]> {
  const spec: FunctionSpec | undefined = Object.hasOwn(PRIVATE_FUNCTIONS, name) ? PRIVATE_FUNCTIONS[name] : undefined;
  if (!spec) throw new Error(`Unknown private function: ${String(name)}`);

  const given = args as Record<string, SqlValue | undefined>;
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(spec.params, key)) throw new Error(`Unknown parameter ${key} for private.${name}`);
  }
  const parts: Prisma.Sql[] = [];
  for (const [paramName, param] of Object.entries(spec.params)) {
    const value = given[paramName];
    if (value === undefined) {
      if (param.required) throw invalid(`${paramName} is required`);
      continue; // the database applies its own default
    }
    parts.push(Prisma.sql`${Prisma.raw(paramName)} => ${bind(paramName, param.type, value)}`);
  }
  const call = parts.length > 0 ? Prisma.join(parts, ', ') : Prisma.empty;
  if (spec.returns === 'void') {
    // The driver cannot deserialize the `void` type; cast it so the call still executes.
    await db.$queryRaw(Prisma.sql`select private.${Prisma.raw(name)}(${call})::text as result`);
    return [];
  }
  return db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`select * from private.${Prisma.raw(name)}(${call})`);
}

/** First column of the first row (scalar functions), or undefined when there is no row. */
export async function callPrivateScalar<N extends PrivateFunctionName>(db: DbClient, name: N, args: PrivateArgs<N>) {
  const [row] = await callPrivate(db, name, args);
  return row ? Object.values(row)[0] : undefined;
}
