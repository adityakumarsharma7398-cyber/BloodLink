import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { AppDeps } from './container.js';
import { createRateLimiters } from './http/rateLimit.js';
import { requestContext, requestLogger, requestTimeout } from './http/requestContext.js';
import { RouteRegistry } from './http/secureRouter.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createApiRouter } from './routes/index.js';

/**
 * Request pipeline:
 *   context (correlation id, IP) -> log -> helmet -> CORS -> timeout -> JSON body
 *   -> auth-failure limiter -> /api routers (each route: its own guards + handlers)
 *   -> 404 -> error handler
 */
export function createApp(deps: AppDeps) {
  const { config, logger } = deps;
  const app = express();
  const registry = new RouteRegistry();
  const limiters = createRateLimiters(config.rateLimit);

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(
    cors({
      origin: [...config.corsOrigins],
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
    }),
  );
  app.use(requestTimeout(config.requestTimeoutMs));
  app.use(express.json({ limit: '1mb' }));

  // API responses are per-user or short-lived by default; reference data opts in to caching itself.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', limiters.authFailureLimiter);
  app.use('/api', createApiRouter(deps, limiters, registry));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return Object.assign(app, { routeRegistry: registry });
}
