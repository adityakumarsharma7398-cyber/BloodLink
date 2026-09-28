import { policy } from '../authz/policy.js';
import type { createDonorActivationController } from '../controllers/donorActivation.controller.js';
import { activationsQuerySchema, idParamsSchema, recipientParamsSchema, respondBodySchema } from '../http/donorActivationSchemas.js';
import { runBodySchema } from '../http/intelligenceSchemas.js';
import type { SecureRouter } from '../http/secureRouter.js';
import { validate } from '../http/validate.js';
import { DONOR_ACTIVATION_MANAGE_ROLES, DONOR_ACTIVATION_READ_ROLES, DONOR_ACTIVATION_RUN_ROLES } from '../services/donorActivationService.js';

/**
 * Blood-centre staff (view/run/notify/cancel) and, separately, a donor's own self-service (their own recipient
 * rows only — enforced in the service by matching the caller's donor profile, never a client-supplied donor id).
 */
export function donorActivationRoutes(routes: SecureRouter, controller: ReturnType<typeof createDonorActivationController>) {
  const readers = policy.anyRole(DONOR_ACTIVATION_READ_ROLES);
  const managers = policy.anyRole(DONOR_ACTIVATION_MANAGE_ROLES);
  // Static paths must be registered before '/:id' so they are never captured as an id.
  routes.post('/runs', policy.anyRole(DONOR_ACTIVATION_RUN_ROLES), validate({ body: runBodySchema }), controller.run);
  routes.get('/mine', policy.anyRole(['DONOR']), controller.mine);
  routes.post('/recipients/:recipientId/respond', policy.anyRole(['DONOR']), validate({ params: recipientParamsSchema, body: respondBodySchema }), controller.respond);

  routes.get('/', readers, validate({ query: activationsQuerySchema }), controller.list);
  routes.get('/:id', readers, validate({ params: idParamsSchema }), controller.get);
  routes.post('/:id/notify', managers, validate({ params: idParamsSchema }), controller.notify);
  routes.post('/:id/cancel', managers, validate({ params: idParamsSchema }), controller.cancel);
}
