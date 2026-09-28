import { apiRequest } from './api';

export type DependencyStatus = 'up' | 'down' | 'not_configured';

export interface BackendHealth {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface DependencyHealth {
  status: 'ok' | 'degraded';
  dependencies: Record<'aiService' | 'supabase', { status: DependencyStatus; latencyMs?: number; detail?: string }>;
  adapters: { maps: string; notifications: string; eraktkosh: string };
  timestamp: string;
}

export const getBackendHealth = () => apiRequest<BackendHealth>('/health');
export const getDependencyHealth = () => apiRequest<DependencyHealth>('/health/dependencies');
