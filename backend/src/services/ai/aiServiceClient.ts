import type { AppConfig } from '../../config/env.js';
import { HttpError } from '../../utils/httpError.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AiServiceClient {
  call<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }): Promise<T>;
}

/**
 * Single entry point for every call from the backend to the Python AI service. Attaches the shared
 * service key so the AI service is not publicly callable. The key never reaches the frontend.
 */
export function createAiServiceClient(config: AppConfig['ai']): AiServiceClient {
  return {
    async call<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (config.apiKey) headers['X-Service-Key'] = config.apiKey;

      let response: Response;
      try {
        response = await fetch(new URL(path, config.url), {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(503, 'AI service is unreachable', 'AI_SERVICE_UNAVAILABLE');
      }
      if (!response.ok) throw new HttpError(502, 'AI service returned an error', 'AI_SERVICE_ERROR');
      return (await response.json()) as T;
    },
  };
}
