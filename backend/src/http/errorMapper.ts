import { ZodError, z } from 'zod';
import { HttpError } from '../utils/httpError.js';

/**
 * Turns ANY thrown value into a safe API error.
 *
 * Rules:
 *  - HttpError / validation / body-parser errors keep their (already safe) status, code and text.
 *  - Database errors are mapped by SQLSTATE to a fixed status + generic message. Raw database text
 *    (which can contain SQL, table/column names, key values or hosts) is NEVER returned.
 *  - Messages raised by BloodLink's own private functions are recognised by a small allow-list and
 *    replaced by a stable business code with fixed wording, so workflows can react to them.
 *  - Everything else is a 500 with a generic message; details go to the server log only.
 */
export interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  headers?: Readonly<Record<string, string>>;
  /** true = log at error level (server fault), false = expected client-visible condition */
  serverFault: boolean;
}

const client = (status: number, code: string, message: string, details?: unknown): MappedError => ({
  status, code, message, details, serverFault: false,
});
const server = (status: number, code: string, message: string): MappedError => ({ status, code, message, serverFault: true });

interface DbError {
  sqlstate: string;
  message: string;
}

/** Finds a SQLSTATE in a pg DatabaseError or in any Prisma 7 / driver-adapter error shape. */
export function extractDbError(error: unknown): DbError | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as {
    code?: unknown; message?: unknown; severity?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } };
  };
  const cause = e.meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') {
    return { sqlstate: cause.originalCode, message: typeof cause.originalMessage === 'string' ? cause.originalMessage : '' };
  }
  // node-postgres DatabaseError (thrown by pg directly)
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.severity === 'string') {
    return { sqlstate: e.code, message: typeof e.message === 'string' ? e.message : '' };
  }
  return null;
}

// Messages raised by our own private functions (migrations 003–005). Matched only for application
// SQLSTATEs (P0001/23514/40001/42501/P0002), so engine-generated text can never match.
const BUSINESS_ERRORS: readonly { pattern: RegExp; status: number; code: string; message: string }[] = [
  { pattern: /insufficient units/i, status: 409, code: 'INSUFFICIENT_UNITS', message: 'Not enough eligible units are available at this source' },
  { pattern: /hold has expired/i, status: 409, code: 'HOLD_EXPIRED', message: 'The temporary hold has expired' },
  { pattern: /status conflict/i, status: 409, code: 'STATE_CONFLICT', message: 'The record was changed by someone else. Reload and try again' },
  { pattern: /invalid unit transition/i, status: 422, code: 'INVALID_UNIT_TRANSITION', message: 'That change is not allowed for the unit in its current state' },
  { pattern: /invalid transfer transition/i, status: 422, code: 'INVALID_TRANSFER_TRANSITION', message: 'That change is not allowed for the transfer in its current state' },
  { pattern: /does not accept temporary holds/i, status: 422, code: 'SOURCE_NOT_ACCEPTING_HOLDS', message: 'This source does not accept temporary holds' },
  { pattern: /planning parameter .* is not configured|hold_timeout_minutes/i, status: 422, code: 'PLANNING_PARAMETER_MISSING', message: 'A required planning parameter is not configured' },
  { pattern: /exceeds the remaining need/i, status: 422, code: 'QUANTITY_EXCEEDS_NEED', message: 'The quantity exceeds what the request still needs' },
  { pattern: /request must be VERIFIED|allocations require a VERIFIED request/i, status: 422, code: 'REQUEST_NOT_VERIFIED', message: 'The request must be verified first' },
  { pattern: /not compatible under an allowed compatibility rule/i, status: 422, code: 'INCOMPATIBLE_UNIT', message: 'The unit is not compatible under an allowed rule' },
  { pattern: /dispatched unit count must equal/i, status: 422, code: 'TRANSFER_QUANTITY_MISMATCH', message: 'The units assigned do not match the approved quantity' },
];
const APPLICATION_SQLSTATES = new Set(['P0001', '23514', '40001', '42501', 'P0002']);

const SQLSTATE_MAP: Record<string, () => MappedError> = {
  '42501': () => client(403, 'FORBIDDEN', 'You do not have permission to do this'),
  '23505': () => client(409, 'CONFLICT', 'That record already exists'),
  '23503': () => client(409, 'CONFLICT', 'The request conflicts with related records'),
  '23514': () => client(422, 'BUSINESS_RULE_VIOLATION', 'The request breaks a business rule'),
  '23502': () => client(400, 'INVALID_ARGUMENT', 'A required value is missing'),
  P0001: () => client(422, 'BUSINESS_RULE_VIOLATION', 'The request breaks a business rule'),
  P0002: () => client(404, 'NOT_FOUND', 'Resource not found'),
  '22023': () => client(400, 'INVALID_ARGUMENT', 'An argument is invalid'),
  '22P02': () => client(400, 'INVALID_ARGUMENT', 'An argument is malformed'),
  '22003': () => client(400, 'INVALID_ARGUMENT', 'A number is out of range'),
  '22001': () => client(400, 'INVALID_ARGUMENT', 'A value is too long'),
  '40001': () => client(409, 'STATE_CONFLICT', 'The record was changed by someone else. Reload and try again'),
  '40P01': () => client(409, 'STATE_CONFLICT', 'The record was changed by someone else. Reload and try again'),
  '55P03': () => client(409, 'RESOURCE_LOCKED', 'The record is being changed. Try again shortly'),
  '57014': () => server(503, 'DATABASE_TIMEOUT', 'The database took too long to respond'),
};

function mapDbError(db: DbError): MappedError {
  if (APPLICATION_SQLSTATES.has(db.sqlstate)) {
    const known = BUSINESS_ERRORS.find((entry) => entry.pattern.test(db.message));
    if (known) return client(known.status, known.code, known.message);
  }
  const mapped = SQLSTATE_MAP[db.sqlstate];
  if (mapped) return mapped();
  if (db.sqlstate.startsWith('08') || db.sqlstate.startsWith('53') || db.sqlstate === '28P01' || db.sqlstate === '3D000') {
    return server(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
  }
  return server(500, 'INTERNAL_ERROR', 'Internal server error');
}

const PRISMA_CODE_MAP: Record<string, () => MappedError> = {
  P2002: () => client(409, 'CONFLICT', 'That record already exists'),
  P2003: () => client(409, 'CONFLICT', 'The request conflicts with related records'),
  P2025: () => client(404, 'NOT_FOUND', 'Resource not found'),
  P2034: () => client(409, 'STATE_CONFLICT', 'The record was changed by someone else. Reload and try again'),
  P2024: () => server(503, 'DATABASE_BUSY', 'The database is busy. Try again shortly'),
  P2028: () => server(503, 'DATABASE_TIMEOUT', 'The database took too long to respond'),
};

const BODY_PARSER_MAP: Record<string, () => MappedError> = {
  'entity.parse.failed': () => client(400, 'INVALID_JSON', 'The request body is not valid JSON'),
  'entity.too.large': () => client(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large'),
  'encoding.unsupported': () => client(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content encoding'),
  'charset.unsupported': () => client(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported character set'),
  'request.aborted': () => client(400, 'REQUEST_ABORTED', 'The request was aborted'),
  'request.size.invalid': () => client(400, 'BAD_REQUEST', 'The request size did not match its declared length'),
};

export function mapError(error: unknown): MappedError {
  if (error instanceof HttpError) {
    return {
      status: error.status, code: error.code, message: error.message, details: error.details,
      headers: error.headers, serverFault: error.status >= 500,
    };
  }
  if (error instanceof ZodError) {
    return client(400, 'VALIDATION_ERROR', 'Invalid request', z.flattenError(error));
  }

  const named = error as { name?: unknown; code?: unknown; type?: unknown; status?: unknown; expose?: unknown } | null;
  if (typeof named?.type === 'string' && BODY_PARSER_MAP[named.type]) return BODY_PARSER_MAP[named.type]!();

  // Database errors first (a Prisma raw-query error carries the SQLSTATE in its metadata)
  const db = extractDbError(error);
  if (db) return mapDbError(db);

  if (named?.name === 'PrismaClientKnownRequestError' && typeof named.code === 'string') {
    const mapped = PRISMA_CODE_MAP[named.code];
    if (mapped) return mapped();
    if (/^P1\d{3}$/.test(named.code)) return server(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
    return server(500, 'INTERNAL_ERROR', 'Internal server error');
  }
  if (named?.name === 'PrismaClientInitializationError') {
    return server(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
  }
  if (named?.name === 'DriverAdapterError') {
    return server(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
  }

  // Other body-parser / http-errors style client faults (4xx that opted in to being exposed)
  if (typeof named?.status === 'number' && named.status >= 400 && named.status < 500 && named.expose === true) {
    return client(named.status, 'BAD_REQUEST', 'Bad request');
  }
  return server(500, 'INTERNAL_ERROR', 'Internal server error');
}
