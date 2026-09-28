import { supabase } from '@/lib/supabase';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True for the codes the backend uses when the caller is signed in but not allowed (see docs/BACKEND.md). */
export const isUnauthorized = (error: unknown): error is ApiError =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

/**
 * All browser → backend calls go through here. The browser never calls the AI service directly, and
 * never holds a service key: the only credential attached is the signed-in user's own Supabase access
 * token, read fresh from the current session for every request (see src/lib/auth.tsx).
 */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init?.headers as Record<string, string>) };
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Backend is unreachable');
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.code,
    );
  }
  return body as T;
}

export const apiGet = <T>(path: string) => apiRequest<T>(path);
export const apiPost = <T>(path: string, body?: unknown) =>
  apiRequest<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** Builds a query string, skipping undefined/null values. */
export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}
