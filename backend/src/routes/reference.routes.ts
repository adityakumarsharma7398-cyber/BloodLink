import { policy } from '../authz/policy.js';
import type { createReferenceController } from '../controllers/reference.controller.js';
import type { SecureRouter } from '../http/secureRouter.js';

/** Blood groups and components are readable by anyone (matches the database's `anon` SELECT policy). */
export function referenceRoutes(
  bloodGroups: SecureRouter,
  components: SecureRouter,
  controller: ReturnType<typeof createReferenceController>,
) {
  bloodGroups.get('/', policy.public(), controller.bloodGroups);
  components.get('/', policy.public(), controller.components);
}
