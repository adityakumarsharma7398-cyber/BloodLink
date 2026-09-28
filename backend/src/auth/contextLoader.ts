import type { DbClient } from '../db/client.js';
import { authRepository } from '../repositories/authRepository.js';
import { HttpError } from '../utils/httpError.js';
import type { AuthContext, FacilityRef, Grant } from './types.js';

export type AuthContextLoader = (userId: string) => Promise<AuthContext>;

const ACTIVE_ORGANIZATION = new Set(['VERIFIED', 'ACTIVE']);

/**
 * Builds the caller's authorization context from the BloodLink database. It applies the same
 * validity rules as the RLS helper functions (migration 006), so backend and database agree:
 *
 *   • the user must exist in public.users and be ACTIVE
 *   • the user's organization (if any) must be VERIFIED or ACTIVE
 *   • a grant counts only while its organization is VERIFIED/ACTIVE (PLATFORM/SELF grants have none)
 *
 * Failures are 403s: the token is genuine but the person is not (or no longer) allowed in.
 */
export function createAuthContextLoader(db: DbClient): AuthContextLoader {
  return async (userId) => {
    const user = await authRepository.findUser(db, userId);
    if (!user) throw new HttpError(403, 'Your account is not set up in BloodLink', 'USER_NOT_PROVISIONED');
    if (user.status !== 'ACTIVE') throw new HttpError(403, 'Your account is not active', 'USER_INACTIVE');
    if (user.organization && !ACTIVE_ORGANIZATION.has(user.organization.status)) {
      throw new HttpError(403, 'Your organization is not active', 'ORGANIZATION_INACTIVE');
    }

    const grants: Grant[] = (await authRepository.findGrants(db, userId))
      .filter((grant) => grant.organizationId === null || (grant.organizationStatus !== null && ACTIVE_ORGANIZATION.has(grant.organizationStatus)))
      // A grant must belong to the user's own organization (enforced by a database trigger too).
      .filter((grant) => grant.organizationId === null || grant.organizationId === user.organizationId)
      .map(({ role, scope, organizationId, facilityId }) => ({ role, scope, organizationId, facilityId }));

    const facilityGrantIds = grants.flatMap((grant) => (grant.scope === 'FACILITY' && grant.facilityId ? [grant.facilityId] : []));
    const administeredOrganizations = grants.flatMap((grant) =>
      grant.role === 'ORG_ADMIN' && grant.scope === 'ORGANIZATION' && grant.organizationId ? [grant.organizationId] : [],
    );
    const facilities: FacilityRef[] = await authRepository.findFacilities(
      db,
      [...new Set(facilityGrantIds)],
      [...new Set(administeredOrganizations)],
    );

    return {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      organization: user.organization ? { id: user.organization.id, name: user.organization.name, type: user.organization.type } : null,
      primaryFacilityId: user.primaryFacilityId,
      grants,
      facilities,
    };
  };
}
