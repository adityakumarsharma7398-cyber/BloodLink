import { policy } from '../authz/policy.js';
import { me } from '../controllers/auth.controller.js';
import type { SecureRouter } from '../http/secureRouter.js';

export function authRoutes(routes: SecureRouter) {
  routes.get('/me', policy.authenticated(), me);
}
