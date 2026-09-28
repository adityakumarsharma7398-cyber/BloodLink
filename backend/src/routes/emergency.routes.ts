import { policy } from '../authz/policy.js';
import type { createEmergencyController } from '../controllers/emergency.controller.js';
import {
  confirmBodySchema, createRequestBodySchema, declineBodySchema, idParamsSchema, incomingQuerySchema, requestsQuerySchema, selectionDecisionBodySchema,
} from '../http/emergencySchemas.js';
import type { SecureRouter } from '../http/secureRouter.js';
import { validate } from '../http/validate.js';
import { EMERGENCY_REQUEST_ROLES, HOLD_SOURCE_ROLES } from '../services/emergencyService.js';

/**
 * Requesting side: hospital / doctor / emergency staff. Source side: blood-bank staff. Facility scope is asserted in the
 * service from the caller's server-resolved grants; the database repeats every role check in its own functions.
 */
export function emergencyRoutes(routes: SecureRouter, controller: ReturnType<typeof createEmergencyController>) {
  const requesters = policy.anyRole(EMERGENCY_REQUEST_ROLES);
  const sources = policy.anyRole(HOLD_SOURCE_ROLES);
  routes.post('/requests', requesters, validate({ body: createRequestBodySchema }), controller.create);
  routes.get('/requests', requesters, validate({ query: requestsQuerySchema }), controller.list);
  routes.get('/requests/:id', requesters, validate({ params: idParamsSchema }), controller.get);
  routes.post('/requests/:id/source-selection', requesters, validate({ params: idParamsSchema }), controller.selectSources);
  routes.post('/source-selections/:id/decision', requesters, validate({ params: idParamsSchema, body: selectionDecisionBodySchema }), controller.decide);
  routes.get('/incoming', sources, validate({ query: incomingQuerySchema }), controller.incoming);
  routes.post('/holds/confirm', sources, validate({ body: confirmBodySchema }), controller.confirm);
  routes.post('/holds/decline', sources, validate({ body: declineBodySchema }), controller.decline);
}
