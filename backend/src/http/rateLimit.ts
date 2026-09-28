import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

export interface RateLimiters {
  /** Applied to routes declared `policy.public()` (unauthenticated traffic), per client IP. */
  readonly publicLimiter: RequestHandler;
  /**
   * Counts ONLY responses that failed authentication (401) per client IP, to slow down token
   * guessing. Successful, authenticated API traffic is never counted, so internal use is not throttled.
   */
  readonly authFailureLimiter: RequestHandler;
}

const tooMany = (req: Request) => {
  const resetTime = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const retryAfterSeconds = Math.max(1, Math.ceil(((resetTime?.getTime() ?? Date.now() + 60_000) - Date.now()) / 1000));
  return new HttpError(429, 'Too many requests. Try again later.', 'RATE_LIMITED', { retryAfterSeconds }, {
    'Retry-After': String(retryAfterSeconds),
  });
};

/**
 * In-memory counters, per server instance. Behind a proxy set TRUST_PROXY so the real client IP
 * is used; with several instances each enforces its own limit (add a shared store if that matters).
 */
export function createRateLimiters(config: AppConfig['rateLimit']): RateLimiters {
  const shared = {
    standardHeaders: 'draft-7' as const,
    legacyHeaders: false,
    passOnStoreError: true, // never take the API down because of the limiter
    handler: (req: Request, _res: unknown, next: (error?: unknown) => void) => next(tooMany(req)),
  };
  return {
    publicLimiter: rateLimit({ ...shared, windowMs: 60_000, limit: config.publicPerMinute }),
    authFailureLimiter: rateLimit({
      ...shared,
      windowMs: 15 * 60_000,
      limit: config.authFailuresPer15Min,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    }),
  };
}
