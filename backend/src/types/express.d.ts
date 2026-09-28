import type { AuthContext } from '../auth/types.js';

export interface RequestContext {
  /** Server-generated per request (never taken from the client). Returned as X-Request-Id. */
  readonly correlationId: string;
  /** Client IP as seen through the configured trust-proxy setting. Logged with the correlation id. */
  readonly ip: string | null;
  readonly startedAt: bigint;
}

export interface ValidatedInput {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

declare global {
  namespace Express {
    interface Request {
      context: RequestContext;
      /** Resolved from the BloodLink database after token verification — the only source of authorization. */
      auth?: AuthContext;
      /** Zod-parsed input (Express 5 makes req.query read-only, so parsed values live here). */
      valid?: ValidatedInput;
    }
  }
}
