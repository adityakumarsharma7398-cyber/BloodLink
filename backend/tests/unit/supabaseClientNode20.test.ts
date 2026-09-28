import { describe, expect, it, vi } from 'vitest';
import { createSupabaseClaimsClient } from '../../src/auth/supabaseTokenVerifier.js';
import { createSupabaseAdminClient } from '../../src/services/supabase/supabaseAdmin.js';

/**
 * Regression: on Node < 22 supabase-js throws "Node.js 20 detected without native WebSocket support"
 * while constructing a client. The backend must pass `ws` explicitly, so construction works
 * even when no global WebSocket exists.
 */
describe('Supabase clients on runtimes without a native WebSocket (Node 20)', () => {
  const URL = 'https://example-project.supabase.co';
  const KEY = 'test-key-not-a-real-secret-0123456789';

  it('constructs the token-verifier and admin clients with no global WebSocket', () => {
    vi.stubGlobal('WebSocket', undefined);
    try {
      expect(() => createSupabaseClaimsClient(URL, KEY)).not.toThrow();
      expect(() => createSupabaseAdminClient({ url: URL, serviceRoleKey: KEY } as never)).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the claims client still exposes getClaims', () => {
    expect(typeof createSupabaseClaimsClient(URL, KEY).getClaims).toBe('function');
  });
});
