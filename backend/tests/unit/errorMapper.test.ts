import { ZodError, z } from 'zod';
import { describe, expect, it } from 'vitest';
import { extractDbError, mapError } from '../../src/http/errorMapper.js';
import { HttpError } from '../../src/utils/httpError.js';

/** The shape Prisma 7 + adapter-pg produces for a failed raw query (verified against a real database). */
const prismaRaw = (originalCode: string, originalMessage: string) =>
  Object.assign(new Error(`Invalid \`prisma.$queryRaw()\` invocation:\n\nRaw query failed. Code: \`${originalCode}\`. Message: \`${originalMessage}\``), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode, originalMessage, kind: 'postgres' } } },
  });

const prismaKnown = (code: string) => Object.assign(new Error(`internal ${code} SELECT * FROM secrets`), { name: 'PrismaClientKnownRequestError', code });

const pgError = (code: string, message: string) => Object.assign(new Error(message), { name: 'error', code, severity: 'ERROR' });

const LEAKY = /select|insert|prisma|postgres|constraint|relation|column|secret|invocation|table/i;

describe('safe passthrough', () => {
  it('keeps HttpError status, code, message, details and headers', () => {
    const mapped = mapError(new HttpError(429, 'Slow down', 'RATE_LIMITED', { retryAfterSeconds: 5 }, { 'Retry-After': '5' }));
    expect(mapped).toMatchObject({ status: 429, code: 'RATE_LIMITED', message: 'Slow down', details: { retryAfterSeconds: 5 }, headers: { 'Retry-After': '5' }, serverFault: false });
    expect(mapError(new HttpError(503, 'x', 'X')).serverFault).toBe(true);
  });

  it('maps Zod errors to 400 VALIDATION_ERROR with field messages only', () => {
    const result = z.strictObject({ email: z.email() }).safeParse({ email: 'not-an-email-zz-SECRET', extra: 1 });
    const mapped = mapError(result.error as ZodError);
    expect(mapped).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(mapped)).not.toContain('zz-SECRET');
  });
});

describe('body-parser errors', () => {
  it.each([
    ['entity.parse.failed', 400, 'INVALID_JSON'],
    ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE'],
    ['encoding.unsupported', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['charset.unsupported', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['request.aborted', 400, 'REQUEST_ABORTED'],
  ])('%s → %i %s', (type, status, code) => {
    const mapped = mapError(Object.assign(new SyntaxError('Unexpected token } in JSON at position 5 {"secret":"x"}'), { type, status: 400, expose: true }));
    expect(mapped).toMatchObject({ status, code, serverFault: false });
    expect(mapped.message).not.toMatch(/token|position|secret/i);
  });
});

describe('database errors are mapped by SQLSTATE with generic text', () => {
  it.each([
    ['42501', 'permission denied for function x', 403, 'FORBIDDEN'],
    ['23505', 'duplicate key value violates unique constraint "u_email" Key (email)=(a@b.c) already exists', 409, 'CONFLICT'],
    ['23503', 'insert or update on table "x" violates foreign key constraint "fk"', 409, 'CONFLICT'],
    ['23514', 'new row for relation "x" violates check constraint "c"', 422, 'BUSINESS_RULE_VIOLATION'],
    ['23502', 'null value in column "name" of relation "x" violates not-null constraint', 400, 'INVALID_ARGUMENT'],
    ['22P02', 'invalid input syntax for type uuid: "nope"', 400, 'INVALID_ARGUMENT'],
    ['22003', 'value out of range', 400, 'INVALID_ARGUMENT'],
    ['P0002', 'request not found', 404, 'NOT_FOUND'],
    ['40001', 'could not serialize access', 409, 'STATE_CONFLICT'],
    ['40P01', 'deadlock detected', 409, 'STATE_CONFLICT'],
    ['55P03', 'could not obtain lock on row', 409, 'RESOURCE_LOCKED'],
    ['57014', 'canceling statement due to statement timeout', 503, 'DATABASE_TIMEOUT'],
    ['08006', 'connection failure', 503, 'DATABASE_UNAVAILABLE'],
    ['53300', 'too many connections', 503, 'DATABASE_UNAVAILABLE'],
    ['28P01', 'password authentication failed for user "postgres"', 503, 'DATABASE_UNAVAILABLE'],
    ['XX000', 'internal error', 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s (raw text never returned)', (sqlstate, text, status, code) => {
    for (const error of [prismaRaw(sqlstate, text), pgError(sqlstate, text)]) {
      const mapped = mapError(error);
      expect(mapped.status).toBe(status);
      expect(mapped.code).toBe(code);
      expect(mapped.message).not.toMatch(LEAKY);
      expect(JSON.stringify(mapped)).not.toContain('a@b.c');
    }
  });

  it('finds the SQLSTATE in the Prisma 7 driver-adapter shape and in pg errors, and ignores everything else', () => {
    expect(extractDbError(prismaRaw('23505', 'dup'))).toEqual({ sqlstate: '23505', message: 'dup' });
    expect(extractDbError(pgError('40001', 'ser'))).toEqual({ sqlstate: '40001', message: 'ser' });
    expect(extractDbError(new Error('plain'))).toBeNull();
    expect(extractDbError({ code: 'ECONNREFUSED' })).toBeNull();
    expect(extractDbError(null)).toBeNull();
  });
});

describe('BloodLink business errors keep stable, safe codes', () => {
  // Messages exactly as raised by the private functions (migrations 004/005).
  it.each([
    ['P0001', 'insufficient units at this source (1 of 2 available)', 409, 'INSUFFICIENT_UNITS'],
    ['40001', 'hold has expired; confirmation refused', 409, 'HOLD_EXPIRED'],
    ['40001', 'allocation status conflict', 409, 'STATE_CONFLICT'],
    ['23514', 'invalid unit transition AVAILABLE -> IN_TRANSIT', 422, 'INVALID_UNIT_TRANSITION'],
    ['23514', 'invalid transfer transition PROPOSED -> IN_TRANSIT', 422, 'INVALID_TRANSFER_TRANSITION'],
    ['23514', 'source facility does not accept temporary holds', 422, 'SOURCE_NOT_ACCEPTING_HOLDS'],
    ['P0002', 'planning parameter "allocation.hold_timeout_minutes" is not configured for facility x', 422, 'PLANNING_PARAMETER_MISSING'],
    ['23514', 'quantity 3 exceeds the remaining need 2', 422, 'QUANTITY_EXCEEDS_NEED'],
    ['23514', 'request must be VERIFIED and open', 422, 'REQUEST_NOT_VERIFIED'],
    ['23514', 'allocations require a VERIFIED request', 422, 'REQUEST_NOT_VERIFIED'],
    ['23514', 'unit is not compatible under an allowed compatibility rule', 422, 'INCOMPATIBLE_UNIT'],
    ['23514', 'dispatched unit count must equal approved_quantity', 422, 'TRANSFER_QUANTITY_MISMATCH'],
  ])('%s "%s" → %i %s', (sqlstate, text, status, code) => {
    const mapped = mapError(prismaRaw(sqlstate, text));
    expect(mapped).toMatchObject({ status, code, serverFault: false });
    expect(mapped.message).not.toContain('facility x');
  });

  it('does not treat a privilege failure that mentions "verified organization" as an unverified request', () => {
    const mapped = mapError(prismaRaw('42501', 'STAFF_AT_CREATION requires an authorized staff creator of a verified organization'));
    expect(mapped).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('never matches an engine-generated message, even one containing a business phrase', () => {
    const mapped = mapError(prismaRaw('23505', 'duplicate key value violates unique constraint "insufficient units"'));
    expect(mapped.code).toBe('CONFLICT');
  });

  it('other 42501 / P0001 messages fall back to generic codes', () => {
    expect(mapError(prismaRaw('42501', 'only blood-bank staff of the source can confirm')).code).toBe('FORBIDDEN');
    expect(mapError(prismaRaw('P0001', 'something unexpected')).code).toBe('BUSINESS_RULE_VIOLATION');
  });
});

describe('Prisma client errors', () => {
  it.each([
    ['P2002', 409, 'CONFLICT'], ['P2003', 409, 'CONFLICT'], ['P2025', 404, 'NOT_FOUND'], ['P2034', 409, 'STATE_CONFLICT'],
    ['P2024', 503, 'DATABASE_BUSY'], ['P2028', 503, 'DATABASE_TIMEOUT'], ['P1001', 503, 'DATABASE_UNAVAILABLE'],
    ['P1002', 503, 'DATABASE_UNAVAILABLE'], ['P1017', 503, 'DATABASE_UNAVAILABLE'], ['P2999', 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', (prismaCode, status, code) => {
    const mapped = mapError(prismaKnown(prismaCode));
    expect(mapped.status).toBe(status);
    expect(mapped.code).toBe(code);
    expect(mapped.message).not.toMatch(LEAKY);
  });

  it('maps initialization and driver-adapter failures to 503 DATABASE_UNAVAILABLE', () => {
    for (const name of ['PrismaClientInitializationError', 'DriverAdapterError']) {
      const mapped = mapError(Object.assign(new Error('Can\'t reach database server at `db.internal:5432`'), { name }));
      expect(mapped).toMatchObject({ status: 503, code: 'DATABASE_UNAVAILABLE', serverFault: true });
      expect(mapped.message).not.toMatch(/internal|5432|reach/);
    }
  });

  it('treats a Prisma validation error as an internal error (a programming bug, not the client)', () => {
    expect(mapError(Object.assign(new Error('Argument `where` is missing'), { name: 'PrismaClientValidationError' })).status).toBe(500);
  });
});

describe('everything else is an opaque 500', () => {
  it('never exposes the message, stack or type of an unknown error', () => {
    const mapped = mapError(new Error('SELECT * FROM users; postgres://u:p@host/db failed at /srv/app/x.ts:12'));
    expect(mapped).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error', serverFault: true });
    expect(JSON.stringify(mapped)).not.toMatch(LEAKY);
    for (const thrown of ['a string', 42, null, undefined, { weird: true }]) expect(mapError(thrown).status).toBe(500);
  });
});
