import { policy } from '../authz/policy.js';
import type { createIntelligenceController } from '../controllers/intelligence.controller.js';
import {
  decisionBodySchema, predictionsQuerySchema, recommendationParamsSchema, recommendationsQuerySchema, runBodySchema,
} from '../http/intelligenceSchemas.js';
import type { SecureRouter } from '../http/secureRouter.js';
import { validate } from '../http/validate.js';
import { INTELLIGENCE_DECIDE_ROLES, INTELLIGENCE_READ_ROLES, INTELLIGENCE_RUN_ROLES } from '../services/intelligenceService.js';

/** The role gate is here; facility scope is asserted in the service against the caller's server-resolved grants. */
export function intelligenceRoutes(routes: SecureRouter, controller: ReturnType<typeof createIntelligenceController>) {
  routes.get('/predictions', policy.anyRole(INTELLIGENCE_READ_ROLES), validate({ query: predictionsQuerySchema }), controller.predictions);
  routes.get('/recommendations', policy.anyRole(INTELLIGENCE_READ_ROLES), validate({ query: recommendationsQuerySchema }), controller.recommendations);
  routes.post('/runs', policy.anyRole(INTELLIGENCE_RUN_ROLES), validate({ body: runBodySchema }), controller.run);
  routes.post('/redistribution/runs', policy.anyRole(INTELLIGENCE_RUN_ROLES), validate({ body: runBodySchema }), controller.redistributionRun);
  routes.post(
    '/recommendations/:id/decision',
    policy.anyRole(INTELLIGENCE_DECIDE_ROLES),
    validate({ params: recommendationParamsSchema, body: decisionBodySchema }),
    controller.decide,
  );
}
