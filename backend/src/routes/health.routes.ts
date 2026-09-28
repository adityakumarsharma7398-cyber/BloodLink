import type { AuthMiddleware } from '../auth/middleware.js';
import { policy } from '../authz/policy.js';
import type { createHealthController } from '../controllers/health.controller.js';
import type { SecureRouter } from '../http/secureRouter.js';

export function healthRoutes(routes: SecureRouter, auth: AuthMiddleware, controller: ReturnType<typeof createHealthController>) {
  // Liveness is probed constantly by the platform, so it is exempt from the public rate limit.
  routes.get('/', policy.public({ rateLimit: false }), controller.live);
  routes.get('/ready', policy.public(), controller.ready);
  routes.get('/dependencies', policy.public(), auth.optionalAuthenticate, controller.dependencies);
}
