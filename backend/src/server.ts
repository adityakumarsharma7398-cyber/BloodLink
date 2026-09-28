import { createApp } from './app.js';
import { ConfigError, describeConfig, loadRuntimeConfig, type AppConfig } from './config/env.js';
import { createRuntimeDeps } from './container.js';

let config: AppConfig;
try {
  config = loadRuntimeConfig();
} catch (error) {
  // ConfigError messages name variables only, never values.
  console.error(error instanceof ConfigError ? error.message : 'Failed to load configuration');
  process.exit(1);
}

const deps = createRuntimeDeps(config);
const { logger } = deps;

const server = createApp(deps).listen(config.port, () => {
  logger.info('server listening', describeConfig(config));
});
// Node's own limits sit just above the application-level request timeout.
server.requestTimeout = config.requestTimeoutMs + 5_000;
server.headersTimeout = Math.min(server.requestTimeout, 30_000);
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => {
    logger.error('forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(() => {
    deps.db
      .disconnect()
      .catch((error: unknown) => logger.warn('database disconnect failed', { error }))
      .finally(() => process.exit(exitCode));
  });
  server.closeIdleConnections();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { error: reason }));
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error });
  shutdown('uncaughtException', 1);
});
