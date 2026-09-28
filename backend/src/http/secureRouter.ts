import { Router, type RequestHandler } from 'express';
import type { AuthMiddleware } from '../auth/middleware.js';
import { requireAnyRole, type Policy } from '../authz/policy.js';
import type { RateLimiters } from './rateLimit.js';

export interface RouteRecord {
  readonly method: string;
  readonly path: string;
  readonly policy: Policy['kind'];
  readonly roles?: readonly string[];
}

export class RouteRegistry {
  readonly routes: RouteRecord[] = [];
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface SecureRouter {
  readonly router: Router;
  get(path: string, policy: Policy, ...handlers: RequestHandler[]): void;
  post(path: string, policy: Policy, ...handlers: RequestHandler[]): void;
  put(path: string, policy: Policy, ...handlers: RequestHandler[]): void;
  patch(path: string, policy: Policy, ...handlers: RequestHandler[]): void;
  delete(path: string, policy: Policy, ...handlers: RequestHandler[]): void;
}

/**
 * The only way routes are added. Each route MUST state its access policy as an argument, and the
 * matching guards (rate limiting for public routes, authentication, role/scope checks) are inserted
 * automatically in front of the handlers. Registered routes are recorded so tests can prove that no
 * route exists without a policy.
 */
export function createSecureRouter(options: {
  basePath: string;
  auth: AuthMiddleware;
  limiters: RateLimiters;
  registry: RouteRegistry;
}): SecureRouter {
  const router = Router();

  const guards = (policy: Policy): RequestHandler[] => {
    switch (policy.kind) {
      case 'public':
        return policy.rateLimit ? [options.limiters.publicLimiter] : [];
      case 'authenticated':
        return [options.auth.authenticate];
      case 'anyRole':
        return [options.auth.authenticate, requireAnyRole(policy.roles, policy.scope)];
    }
  };

  const add = (method: Method, path: string, policy: Policy, handlers: RequestHandler[]) => {
    options.registry.routes.push({
      method: method.toUpperCase(),
      path: `${options.basePath}${path === '/' ? '' : path}`,
      policy: policy.kind,
      roles: policy.kind === 'anyRole' ? policy.roles : undefined,
    });
    router[method](path, ...guards(policy), ...handlers);
  };

  return {
    router,
    get: (path, policy, ...handlers) => add('get', path, policy, handlers),
    post: (path, policy, ...handlers) => add('post', path, policy, handlers),
    put: (path, policy, ...handlers) => add('put', path, policy, handlers),
    patch: (path, policy, ...handlers) => add('patch', path, policy, handlers),
    delete: (path, policy, ...handlers) => add('delete', path, policy, handlers),
  };
}
