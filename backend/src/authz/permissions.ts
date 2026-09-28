import type { AppRole, AuthContext, Grant } from '../auth/types.js';
import { HttpError, notFound } from '../utils/httpError.js';

/**
 * Deny-by-default permission checks over the server-resolved AuthContext.
 *
 * Principles:
 *  - Roles are independent permission sets; no role implies another. SUPER_ADMIN is not a
 *    wildcard: it grants exactly the platform actions that name it (verify organizations, manage
 *    compatibility rules and planning parameters, read) and passes NO facility/organization scope check.
 *  - Organization and facility access is derived from FACILITY / ORGANIZATION scope grants only.
 *    SELF-scope roles (DONOR, PUBLIC_REQUESTER) and PLATFORM grants never confer any.
 *  - IDs supplied by a client (params, body, query, headers) are only ever the *resource* being asked
 *    about; they are compared against the server-resolved grants and are never trusted as authority.
 */

export interface ScopeTarget {
  readonly facilityId?: string;
  readonly organizationId?: string;
}

const isScoped = (grant: Grant) => grant.scope === 'FACILITY' || grant.scope === 'ORGANIZATION';

/** Does an ORG_ADMIN grant of this user cover the given facility? */
function orgAdminCoversFacility(auth: AuthContext, facilityId: string): boolean {
  const facility = auth.facilities.find((candidate) => candidate.id === facilityId);
  if (!facility) return false;
  return auth.grants.some(
    (grant) => grant.role === 'ORG_ADMIN' && grant.scope === 'ORGANIZATION' && grant.organizationId === facility.organizationId,
  );
}

/** True if the user holds any of `roles`, optionally within a facility or organization. */
export function hasAnyRole(auth: AuthContext, roles: readonly AppRole[], target: ScopeTarget = {}): boolean {
  const wanted = new Set<AppRole>(roles);

  if (target.facilityId !== undefined) {
    const facilityId = target.facilityId;
    return (
      auth.grants.some((grant) => wanted.has(grant.role) && grant.scope === 'FACILITY' && grant.facilityId === facilityId) ||
      (wanted.has('ORG_ADMIN') && orgAdminCoversFacility(auth, facilityId))
    );
  }
  if (target.organizationId !== undefined) {
    const organizationId = target.organizationId;
    return auth.grants.some((grant) => wanted.has(grant.role) && isScoped(grant) && grant.organizationId === organizationId);
  }
  return auth.grants.some((grant) => wanted.has(grant.role));
}

export const hasRole = (auth: AuthContext, role: AppRole, target?: ScopeTarget) => hasAnyRole(auth, [role], target);

export const isSuperAdmin = (auth: AuthContext) => auth.grants.some((grant) => grant.role === 'SUPER_ADMIN' && grant.scope === 'PLATFORM');

/** The user acts inside this organization through at least one organization/facility grant. */
export const isOrganizationMember = (auth: AuthContext, organizationId: string) =>
  auth.grants.some((grant) => isScoped(grant) && grant.organizationId === organizationId);

/** The user may act in this facility (facility grant, or org-wide ORG_ADMIN of its organization). */
export const canAccessFacility = (auth: AuthContext, facilityId: string) => auth.facilities.some((facility) => facility.id === facilityId);

export const accessibleFacilityIds = (auth: AuthContext): readonly string[] => auth.facilities.map((facility) => facility.id);

export interface AssertOptions {
  /** Require one of these roles within the scope (role is checked at that facility/organization). */
  readonly roles?: readonly AppRole[];
  /** Answer 404 instead of 403 so the existence of other tenants' resources is not revealed. */
  readonly hide?: boolean;
}

const deny = (hide?: boolean) => (hide ? notFound() : new HttpError(403, 'You do not have permission to do this', 'FORBIDDEN'));

export function assertOrganizationAccess(auth: AuthContext, organizationId: string, options: AssertOptions = {}): void {
  const allowed = options.roles ? hasAnyRole(auth, options.roles, { organizationId }) : isOrganizationMember(auth, organizationId);
  if (!allowed) throw deny(options.hide);
}

export function assertFacilityAccess(auth: AuthContext, facilityId: string, options: AssertOptions = {}): void {
  const allowed = options.roles ? hasAnyRole(auth, options.roles, { facilityId }) : canAccessFacility(auth, facilityId);
  if (!allowed) throw deny(options.hide);
}

export function assertAnyRole(auth: AuthContext, roles: readonly AppRole[], target: ScopeTarget = {}): void {
  if (!hasAnyRole(auth, roles, target)) throw deny(false);
}
