import { createClient } from '@supabase/supabase-js';
import { isUuid } from '../lib/ids.js';
import { serverClientOptions } from '../services/supabase/clientOptions.js';
import { HttpError } from '../utils/httpError.js';
import type { TokenVerifier } from './tokenVerifier.js';

/** The slice of supabase-js we depend on — small enough to fake in tests. */
export interface ClaimsClient {
  getClaims(jwt: string): Promise<{ data: { claims: Record<string, unknown> } | null; error: unknown }>;
}

const invalidToken = () => new HttpError(401, 'Invalid or expired token', 'INVALID_TOKEN');

/**
 * Verifies a Supabase access token with `auth.getClaims()`: the signature is checked against the
 * project's published signing keys (JWKS, cached) and expiry is enforced. Only the identity
 * (`sub`, `email`) is returned — roles, organizations and every other claim are ignored on purpose.
 */
export function createSupabaseTokenVerifier(client: ClaimsClient): TokenVerifier {
  return {
    async verify(token) {
      let result: Awaited<ReturnType<ClaimsClient['getClaims']>>;
      try {
        result = await client.getClaims(token);
      } catch {
        throw new HttpError(503, 'Authentication is temporarily unavailable', 'AUTH_PROVIDER_UNAVAILABLE');
      }
      const { data, error } = result;
      if (error) {
        const name = (error as { name?: unknown }).name;
        const status = (error as { status?: unknown }).status;
        if (name === 'AuthRetryableFetchError' || (typeof status === 'number' && status >= 500)) {
          throw new HttpError(503, 'Authentication is temporarily unavailable', 'AUTH_PROVIDER_UNAVAILABLE');
        }
        throw invalidToken();
      }
      const claims = data?.claims;
      if (!claims) throw invalidToken();

      // Only signed-in end users: rejects the publishable/anon key and service tokens.
      if (claims.role !== 'authenticated' || claims.is_anonymous === true || !isUuid(claims.sub)) throw invalidToken();
      return { userId: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
    },
  };
}

/** Uses the publishable (anon) key only: it is enough to verify tokens and holds no privileges. */
export function createSupabaseClaimsClient(url: string, publishableKey: string): ClaimsClient {
  const client = createClient(url, publishableKey, serverClientOptions);
  return client.auth as unknown as ClaimsClient;
}
