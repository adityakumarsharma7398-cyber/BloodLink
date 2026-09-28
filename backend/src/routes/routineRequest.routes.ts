import { policy } from '../authz/policy.js';
import type { createRoutineRequestController } from '../controllers/routineRequest.controller.js';
import { createRequestBodySchema, idParamsSchema, requestsQuerySchema } from '../http/emergencySchemas.js';
import type { SecureRouter } from '../http/secureRouter.js';
import { validate } from '../http/validate.js';
import { ROUTINE_REQUEST_ROLES } from '../services/routineRequestService.js';

/** HOSPITAL_STAFF and DOCTOR only. Facility scope is asserted in the service from the caller's server-resolved grants. */
export function routineRequestRoutes(routes: SecureRouter, controller: ReturnType<typeof createRoutineRequestController>) {
  const staff = policy.anyRole(ROUTINE_REQUEST_ROLES);
  routes.post('/', staff, validate({ body: createRequestBodySchema }), controller.create);
  routes.get('/', staff, validate({ query: requestsQuerySchema }), controller.list);
  routes.get('/:id', staff, validate({ params: idParamsSchema }), controller.get);
}
