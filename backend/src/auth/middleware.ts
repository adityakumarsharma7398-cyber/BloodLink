import type { Request, RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';
import { HttpError } from '../utils/httpError.js';
import type { AuthContextLoader } from './contextLoader.js';
import type { TokenVerifier } from './tokenVerifier.js';

const BEARER = /^Bearer\s+([A-Za-z0-9\-._~+/]{10,8192}=*)$/i;

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

export interface AuthMiddleware {
  /** Requires a valid token and an active BloodLink user; sets req.auth. */
  authenticate: RequestHandler;
  /** Sets req.auth when a valid token is present; otherwise continues anonymously (never errors). */
  optionalAuthenticate: RequestHandler;
}

export function createAuthMiddleware(deps: { tokenVerifier: TokenVerifier; loadContext: AuthContextLoader; logger: Logger }): AuthMiddleware {
  const resolve = async (req: Request) => {
    if (typeof req.headers.authorization !== 'string') throw new HttpError(401, 'Authentication required', 'AUTH_REQUIRED');
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Authorization header must be "Bearer <token>"', 'AUTH_REQUIRED');
    const identity = await deps.tokenVerifier.verify(token);
    return deps.loadContext(identity.userId);
  };

  return {
    authenticate: async (req, _res, next) => {
      try {
        req.auth = await resolve(req);
        next();
      } catch (error) {
        next(error);
      }
    },
    optionalAuthenticate: async (req, _res, next) => {
      if (typeof req.headers.authorization === 'string') {
        try {
          req.auth = await resolve(req);
        } catch (error) {
          // Fail closed: any problem means "anonymous", which only ever sees less.
          deps.logger.debug('optional authentication ignored', { requestId: req.context?.correlationId, error });
        }
      }
      next();
    },
  };
}
