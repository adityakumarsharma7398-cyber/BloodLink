import { describe, expect, it, vi } from 'vitest';
import { createSupabaseTokenVerifier, type ClaimsClient } from '../../src/auth/supabaseTokenVerifier.js';
import { HttpError } from '../../src/utils/httpError.js';

const USER = '3f6f9c3e-5b0a-4f6e-9d1a-0e6b1c2d3e4f';
const verifierFor = (result: Awaited<ReturnType<ClaimsClient['getClaims']>> | Error) =>
  createSupabaseTokenVerifier({
    getClaims: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  });

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as HttpError;
  }
  throw new Error('expected a rejection');
};

describe('createSupabaseTokenVerifier', () => {
  it('returns only the identity of a valid signed-in user', async () => {
    const verifier = verifierFor({
      data: { claims: { sub: USER, email: 'a@b.test', role: 'authenticated', app_metadata: { role: 'SUPER_ADMIN' }, user_metadata: { org: 'x' } } },
      error: null,
    });
    const identity = await verifier.verify('token-value-1234');
    expect(identity).toEqual({ userId: USER, email: 'a@b.test' });
    expect(Object.keys(identity)).toEqual(['userId', 'email']); // roles / metadata claims are never propagated
  });

  it('rejects tokens the provider rejects', async () => {
    const error = await rejection(verifierFor({ data: null, error: { name: 'AuthInvalidJwtError', message: 'bad signature' } }).verify('token-value-1234'));
    expect(error).toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
    expect(error.message).not.toContain('signature');
  });

  it.each([
    ['the anon/publishable key', { sub: USER, role: 'anon' }],
    ['a service token', { sub: USER, role: 'service_role' }],
    ['an anonymous sign-in', { sub: USER, role: 'authenticated', is_anonymous: true }],
    ['a subject that is not a UUID', { sub: 'admin', role: 'authenticated' }],
    ['a missing subject', { role: 'authenticated' }],
  ])('rejects %s', async (_label, claims) => {
    const error = await rejection(verifierFor({ data: { claims }, error: null }).verify('token-value-1234'));
    expect(error).toMatchObject({ status: 401, code: 'INVALID_TOKEN' });
  });

  it('answers 503 (not 401) when the auth provider is unreachable, so clients do not log users out', async () => {
    for (const result of [
      { data: null, error: { name: 'AuthRetryableFetchError', message: 'fetch failed' } },
      { data: null, error: { name: 'AuthApiError', status: 502, message: 'bad gateway' } },
    ]) {
      expect(await rejection(verifierFor(result).verify('token-value-1234'))).toMatchObject({ status: 503, code: 'AUTH_PROVIDER_UNAVAILABLE' });
    }
    expect(await rejection(verifierFor(new Error('network down')).verify('token-value-1234'))).toMatchObject({ status: 503, code: 'AUTH_PROVIDER_UNAVAILABLE' });
  });

  it('passes the token to getClaims unchanged', async () => {
    const getClaims = vi.fn(async () => ({ data: { claims: { sub: USER, role: 'authenticated' } }, error: null }));
    await createSupabaseTokenVerifier({ getClaims }).verify('the-token-1234');
    expect(getClaims).toHaveBeenCalledWith('the-token-1234');
  });
});
