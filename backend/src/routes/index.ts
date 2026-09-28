import { Router } from 'express';
import { createAuthContextLoader } from '../auth/contextLoader.js';
import { createAuthMiddleware } from '../auth/middleware.js';
import type { AppDeps } from '../container.js';
import { createHealthController } from '../controllers/health.controller.js';
import { createAuditService } from '../audit/auditService.js';
import { createEmergencyController } from '../controllers/emergency.controller.js';
import { createTransferController } from '../controllers/transfer.controller.js';
import { createIntelligenceController } from '../controllers/intelligence.controller.js';
import { createDonorActivationController } from '../controllers/donorActivation.controller.js';
import { createInventoryController } from '../controllers/inventory.controller.js';
import { createReferenceController } from '../controllers/reference.controller.js';
import type { RateLimiters } from '../http/rateLimit.js';
import { createSecureRouter, type RouteRegistry } from '../http/secureRouter.js';
import { createEmergencyService } from '../services/emergencyService.js';
import { createRedistributionService } from '../services/redistributionService.js';
import { createTransferService } from '../services/transferService.js';
import { createIntelligenceService } from '../services/intelligenceService.js';
import { createDonorActivationService } from '../services/donorActivationService.js';
import { createNotificationAdapter } from '../services/notifications/notificationAdapter.js';
import { createInventoryService } from '../services/inventoryService.js';
import { createReferenceService } from '../services/referenceService.js';
import { createRoutineRequestService } from '../services/routineRequestService.js';
import { createRoutineRequestController } from '../controllers/routineRequest.controller.js';
import { authRoutes } from './auth.routes.js';
import { healthRoutes } from './health.routes.js';
import { emergencyRoutes } from './emergency.routes.js';
import { transferRoutes } from './transfer.routes.js';
import { intelligenceRoutes } from './intelligence.routes.js';
import { donorActivationRoutes } from './donorActivation.routes.js';
import { inventoryRoutes } from './inventory.routes.js';
import { referenceRoutes } from './reference.routes.js';
import { routineRequestRoutes } from './routineRequest.routes.js';

/**
 * Composes every /api router. Domain routers (organizations, inventory, requests, transfers, ...)
 * are added here in later phases, each through createSecureRouter so it must declare a policy.
 */
export function createApiRouter(deps: AppDeps, limiters: RateLimiters, registry: RouteRegistry): Router {
  const auth = createAuthMiddleware({
    tokenVerifier: deps.tokenVerifier,
    loadContext: deps.loadContext ?? createAuthContextLoader(deps.db.prisma),
    logger: deps.logger,
  });
  // basePath is the FULL public path recorded in the route registry (routers are mounted below /api).
  const secure = (name: string) => createSecureRouter({ basePath: `/api/${name}`, auth, limiters, registry });

  const health = secure('health');
  const authRouter = secure('auth');
  const bloodGroups = secure('blood-groups');
  const components = secure('components');
  const inventory = secure('inventory');
  const intelligence = secure('intelligence');
  const transfersRouter = secure('transfers');
  const emergency = secure('emergency');
  const donorActivations = secure('donor-activations');
  const requestsRouter = secure('requests');

  healthRoutes(health, auth, createHealthController({ config: deps.config, probes: deps.probes }));
  authRoutes(authRouter);
  referenceRoutes(bloodGroups, components, createReferenceController(createReferenceService(deps.db)));
  inventoryRoutes(inventory, createInventoryController(createInventoryService(deps.db)));
  const audit = createAuditService(deps.logger);
  const transferService = createTransferService(deps.db, audit);
  const notificationAdapter = createNotificationAdapter(deps.config.adapters.notifications);
  const donorActivationService = createDonorActivationService(deps.db, audit, notificationAdapter, {
    allowDemoRules: deps.config.compatibility.allowDemoRules,
  });
  intelligenceRoutes(
    intelligence,
    createIntelligenceController(
      createIntelligenceService(deps.db, audit, transferService, donorActivationService, deps.aiClient),
      createRedistributionService(deps.db, audit),
    ),
  );
  transferRoutes(transfersRouter, createTransferController(transferService));
  emergencyRoutes(emergency, createEmergencyController(createEmergencyService(deps.db, audit, { allowDemoRules: deps.config.compatibility.allowDemoRules })));
  donorActivationRoutes(donorActivations, createDonorActivationController(donorActivationService));
  routineRequestRoutes(requestsRouter, createRoutineRequestController(createRoutineRequestService(deps.db, audit)));

  const router = Router();
  router.use('/health', health.router);
  router.use('/auth', authRouter.router);
  router.use('/blood-groups', bloodGroups.router);
  router.use('/components', components.router);
  router.use('/inventory', inventory.router);
  router.use('/intelligence', intelligence.router);
  router.use('/transfers', transfersRouter.router);
  router.use('/emergency', emergency.router);
  router.use('/donor-activations', donorActivations.router);
  router.use('/requests', requestsRouter.router);
  return router;
}
