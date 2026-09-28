import type { $Enums } from '../generated/prisma/client.js';

/** The ten approved roles (database enum `app_role`). Independent permission sets, no hierarchy. */
export type AppRole = $Enums.app_role;
export type RoleScope = $Enums.role_scope;
export type OrganizationType = $Enums.organization_type;
export type FacilityType = $Enums.facility_type;

export interface Grant {
  readonly role: AppRole;
  readonly scope: RoleScope;
  /** null for PLATFORM / SELF grants */
  readonly organizationId: string | null;
  /** set only for FACILITY grants */
  readonly facilityId: string | null;
}

export interface FacilityRef {
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly facilityType: FacilityType;
}

/**
 * Everything the backend knows about the caller. Built ONLY from the BloodLink database after the
 * token identity has been verified — never from JWT claims, headers or request bodies.
 */
export interface AuthContext {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly organization: { readonly id: string; readonly name: string; readonly type: OrganizationType } | null;
  readonly primaryFacilityId: string | null;
  /** Valid grants only (active user, VERIFIED/ACTIVE organization). */
  readonly grants: readonly Grant[];
  /** Facilities the user may act in: facility grants plus every facility of an organization they administer. */
  readonly facilities: readonly FacilityRef[];
}
