import type { Request, RequestHandler } from 'express';
import type { AppRole } from '../auth/types.js';
import { HttpError } from '../utils/httpError.js';
import { assertAnyRole, assertFacilityAccess, assertOrganizationAccess, type ScopeTarget } from './permissions.js';

/**
 * Every route must declare its access policy explicitly (see http/secureRouter.ts). There is no
 * implicit "anyone" — a route is public only when it says `policy.public()`.
 */
export type ScopeResolver = (req: Request) => ScopeTarget;

export type Policy =
  | { readonly kind: 'public'; readonly rateLimit: boolean }
  | { readonly kind: 'authenticated' }
  | { readonly kind: 'anyRole'; readonly roles: readonly AppRole[]; readonly scope?: ScopeResolver };

export const policy = {
  /** No token needed. Rate-limited by default. */
  public: (options: { rateLimit?: boolean } = {}): Policy => ({ kind: 'public', rateLimit: options.rateLimit ?? true }),
  /** Any signed-in, active BloodLink user (including DONOR and PUBLIC_REQUESTER). */
  authenticated: (): Policy => ({ kind: 'authenticated' }),
  /** Holds at least one of the roles — optionally within a facility/organization resolved from the request. */
  anyRole: (roles: readonly AppRole[], scope?: ScopeResolver): Policy => ({ kind: 'anyRole', roles, scope }),
  role: (role: AppRole, scope?: ScopeResolver): Policy => ({ kind: 'anyRole', roles: [role], scope }),
};

const needAuth = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'Authentication required', 'AUTH_REQUIRED');
  return req.auth;
};

/** Must run after `authenticate`. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  try {
    needAuth(req);
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAnyRole =
  (roles: readonly AppRole[], scope?: ScopeResolver): RequestHandler =>
  (req, _res, next) => {
    try {
      assertAnyRole(needAuth(req), roles, scope?.(req));
      next();
    } catch (error) {
      next(error);
    }
  };

export const requireRole = (role: AppRole, scope?: ScopeResolver) => requireAnyRole([role], scope);

/** The caller must belong to the organization named by the request (checked against server-side grants). */
export const requireOrganizationAccess =
  (getOrganizationId: (req: Request) => string, roles?: readonly AppRole[]): RequestHandler =>
  (req, _res, next) => {
    try {
      assertOrganizationAccess(needAuth(req), getOrganizationId(req), { roles });
      next();
    } catch (error) {
      next(error);
    }
  };

export const requireFacilityAccess =
  (getFacilityId: (req: Request) => string, roles?: readonly AppRole[]): RequestHandler =>
  (req, _res, next) => {
    try {
      assertFacilityAccess(needAuth(req), getFacilityId(req), { roles });
      next();
    } catch (error) {
      next(error);
    }
  };
