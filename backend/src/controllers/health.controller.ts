import type { RequestHandler } from 'express';
import { isSuperAdmin } from '../authz/permissions.js';
import type { AppConfig } from '../config/env.js';
import type { Probe } from '../services/probes.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

export interface HealthDeps {
  config: AppConfig;
  probes: { database: Probe; ai: Probe; supabase: Probe };
}

export function createHealthController({ config, probes }: HealthDeps) {
  /** Liveness: proves the process is up. Deliberately independent of every dependency, including the database. */
  const live: RequestHandler = (_req, res) => {
    res.json({
      status: 'ok',
      service: 'bloodlink-backend',
      version: VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  };

  /** Readiness: can this instance serve traffic? Only the database matters. No detail is returned. */
  const ready: RequestHandler = async (_req, res) => {
    const database = await probes.database();
    const isReady = database.status === 'up';
    res.status(isReady ? 200 : 503).json({ status: isReady ? 'ready' : 'not_ready', timestamp: new Date().toISOString() });
  };

  /** Anonymous callers get only the overall status; platform super-admins get per-dependency detail. */
  const dependencies: RequestHandler = async (req, res) => {
    const [database, aiService, supabase] = await Promise.all([probes.database(), probes.ai(), probes.supabase()]);
    const status = [database, aiService, supabase].some((dependency) => dependency.status === 'down') ? 'degraded' : 'ok';
    const timestamp = new Date().toISOString();

    if (req.auth && isSuperAdmin(req.auth)) {
      res.json({
        status,
        dependencies: { database, aiService, supabase },
        adapters: {
          maps: config.adapters.maps.provider,
          notifications: config.adapters.notifications.provider,
          eraktkosh: config.adapters.eraktkosh.mode,
        },
        timestamp,
      });
      return;
    }
    res.json({ status, timestamp });
  };

  return { live, ready, dependencies };
}
