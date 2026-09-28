import { policy } from '../authz/policy.js';
import type { createInventoryController } from '../controllers/inventory.controller.js';
import { summaryQuerySchema, unitsQuerySchema } from '../http/inventorySchemas.js';
import type { SecureRouter } from '../http/secureRouter.js';
import { validate } from '../http/validate.js';
import { INVENTORY_READ_ROLES } from '../services/inventoryService.js';

/** Read-only. The role gate is here; facility scope is asserted per facility in the service. */
export function inventoryRoutes(routes: SecureRouter, controller: ReturnType<typeof createInventoryController>) {
  const readers = policy.anyRole(INVENTORY_READ_ROLES);
  routes.get('/summary', readers, validate({ query: summaryQuerySchema }), controller.summary);
  routes.get('/units', readers, validate({ query: unitsQuerySchema }), controller.units);
}
