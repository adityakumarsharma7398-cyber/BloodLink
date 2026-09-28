import { policy } from '../authz/policy.js';
import type { createTransferController } from '../controllers/transfer.controller.js';
import type { SecureRouter } from '../http/secureRouter.js';
import { approveBodySchema, rejectBodySchema, transferParamsSchema, transfersQuerySchema } from '../http/transferSchemas.js';
import { validate } from '../http/validate.js';
import { INVENTORY_READ_ROLES } from '../services/inventoryService.js';
import { TRANSFER_DECIDE_ROLES } from '../services/transferService.js';

/** Both sides of a transfer read it; only the source BLOOD_BANK_ADMIN decides it (the database enforces the same). */
export function transferRoutes(routes: SecureRouter, controller: ReturnType<typeof createTransferController>) {
  const readers = policy.anyRole(INVENTORY_READ_ROLES);
  routes.get('/', readers, validate({ query: transfersQuerySchema }), controller.list);
  routes.get('/:id', readers, validate({ params: transferParamsSchema }), controller.get);
  routes.post('/:id/approve', policy.anyRole(TRANSFER_DECIDE_ROLES), validate({ params: transferParamsSchema, body: approveBodySchema }), controller.approve);
  routes.post('/:id/reject', policy.anyRole(TRANSFER_DECIDE_ROLES), validate({ params: transferParamsSchema, body: rejectBodySchema }), controller.reject);
}
