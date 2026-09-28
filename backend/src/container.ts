import { createAuthContextLoader, type AuthContextLoader } from './auth/contextLoader.js';
import { createSupabaseClaimsClient, createSupabaseTokenVerifier } from './auth/supabaseTokenVerifier.js';
import type { TokenVerifier } from './auth/tokenVerifier.js';
import type { AppConfig } from './config/env.js';
import { createDatabase, type Database } from './db/client.js';
import { createLogger, type Logger } from './lib/logger.js';
import { createAiServiceClient, type AiServiceClient } from './services/ai/aiServiceClient.js';
import { aiServiceProbe, databaseProbe, supabaseProbe, type Probe } from './services/probes.js';
import { HttpError } from './utils/httpError.js';

/** Everything the HTTP app needs. Runtime wiring lives here; tests inject their own fakes. */
export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  db: Database;
  tokenVerifier: TokenVerifier;
  /** Resolves a verified identity into BloodLink authorization data. Defaults to the database loader. */
  loadContext?: AuthContextLoader;
  probes: { database: Probe; ai: Probe; supabase: Probe };
  /** The one entry point for every call to the Python AI service (demand forecasting and later models). */
  aiClient: AiServiceClient;
}

const notConfiguredVerifier: TokenVerifier = {
  async verify() {
    throw new HttpError(503, 'Authentication is not configured', 'AUTH_PROVIDER_UNAVAILABLE');
  },
};

export function createRuntimeDeps(config: AppConfig): AppDeps {
  const logger = createLogger({ level: config.logLevel });
  const db = createDatabase(config.database, logger);
  const { url, anonKey } = config.supabase;
  const aiClient = createAiServiceClient(config.ai);
  return {
    config,
    logger,
    db,
    tokenVerifier: url && anonKey ? createSupabaseTokenVerifier(createSupabaseClaimsClient(url, anonKey)) : notConfiguredVerifier,
    loadContext: createAuthContextLoader(db.prisma),
    probes: {
      database: databaseProbe(db),
      ai: aiServiceProbe(aiClient),
      supabase: supabaseProbe(config.supabase),
    },
    aiClient,
  };
}
