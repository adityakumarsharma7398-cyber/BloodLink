import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../../config/env.js';
import { serverClientOptions } from './clientOptions.js';

/**
 * SUPABASE CLIENT BOUNDARIES
 *  - Browser (frontend): publishable/anon key only. Auth sessions and Realtime reads; it never writes
 *    BloodLink tables and never sees any key below.
 *  - Token verification (src/auth/supabaseTokenVerifier.ts): publishable key, `auth.getClaims()` only.
 *  - THIS admin client (service-role key, bypasses RLS): reserved for Supabase Auth ADMIN operations
 *    such as inviting a user. It must never be used to read or write BloodLink tables; data access
 *    goes through Prisma with DATABASE_URL, behind authentication and authorization.
 *  Not used by any route yet.
 */
export function createSupabaseAdminClient(config: AppConfig['supabase']): SupabaseClient {
  if (!config.url || !config.serviceRoleKey) {
    throw new Error('Supabase admin client is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(config.url, config.serviceRoleKey, serverClientOptions);
}
