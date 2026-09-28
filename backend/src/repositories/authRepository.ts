import type { DbClient } from '../db/client.js';
import type { FacilityType, OrganizationType, RoleScope, AppRole } from '../auth/types.js';

export interface UserRecord {
  id: string;
  email: string;
  fullName: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  organizationId: string | null;
  primaryFacilityId: string | null;
  organization: { id: string; name: string; type: OrganizationType; status: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'SUSPENDED' } | null;
}

export interface GrantRecord {
  role: AppRole;
  scope: RoleScope;
  organizationId: string | null;
  facilityId: string | null;
  /** status of the grant's organization (null for PLATFORM / SELF grants) */
  organizationStatus: 'PENDING' | 'VERIFIED' | 'ACTIVE' | 'SUSPENDED' | null;
}

export interface FacilityRecord {
  id: string;
  name: string;
  organizationId: string;
  facilityType: FacilityType;
}

/** Read-only queries that resolve a caller's identity into BloodLink authorization data. */
export const authRepository = {
  async findUser(db: DbClient, userId: string): Promise<UserRecord | null> {
    const user = await db.public_users.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, full_name: true, status: true, organization_id: true, facility_id: true,
        organizations: { select: { id: true, name: true, type: true, status: true } },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      status: user.status,
      organizationId: user.organization_id,
      primaryFacilityId: user.facility_id,
      organization: user.organizations,
    };
  },

  async findGrants(db: DbClient, userId: string): Promise<GrantRecord[]> {
    const rows = await db.user_roles.findMany({
      where: { user_id: userId },
      select: {
        organization_id: true, facility_id: true,
        roles: { select: { code: true, scope: true } },
        organizations: { select: { status: true } },
      },
    });
    return rows.map((row) => ({
      role: row.roles.code,
      scope: row.roles.scope,
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      organizationStatus: row.organizations?.status ?? null,
    }));
  },

  /** Facilities named by facility grants plus every facility of the given (administered) organizations. */
  async findFacilities(db: DbClient, facilityIds: string[], organizationIds: string[]): Promise<FacilityRecord[]> {
    if (facilityIds.length === 0 && organizationIds.length === 0) return [];
    const rows = await db.facilities.findMany({
      where: { OR: [{ id: { in: facilityIds } }, { organization_id: { in: organizationIds } }] },
      select: { id: true, name: true, organization_id: true, facility_type: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({ id: row.id, name: row.name, organizationId: row.organization_id, facilityType: row.facility_type }));
  },
};
