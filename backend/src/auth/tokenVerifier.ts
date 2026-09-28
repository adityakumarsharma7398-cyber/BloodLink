/**
 * The token proves WHO is calling and nothing else. It never determines what they may do — that
 * comes from the BloodLink database (see contextLoader.ts).
 */
export interface VerifiedIdentity {
  /** auth.users.id (JWT `sub`) */
  readonly userId: string;
  readonly email: string | null;
}

export interface TokenVerifier {
  /** Resolves the caller's identity or throws HttpError(401 INVALID_TOKEN | 503 AUTH_PROVIDER_UNAVAILABLE). */
  verify(token: string): Promise<VerifiedIdentity>;
}
