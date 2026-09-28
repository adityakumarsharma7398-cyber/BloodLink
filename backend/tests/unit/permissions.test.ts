import { describe, expect, it } from 'vitest';
import type { AppRole } from '../../src/auth/types.js';
import {
  accessibleFacilityIds, assertFacilityAccess, assertOrganizationAccess, canAccessFacility, hasAnyRole, hasRole,
  isOrganizationMember, isSuperAdmin,
} from '../../src/authz/permissions.js';
import { HttpError } from '../../src/utils/httpError.js';
import { context, FACILITIES, facilityGrant, ID, selfGrant, USERS } from '../support/contexts.js';

const ALL_ROLES: AppRole[] = [
  'SUPER_ADMIN', 'ORG_ADMIN', 'HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF',
  'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER', 'DONOR', 'PUBLIC_REQUESTER',
];

const status = (fn: () => void) => {
  try {
    fn();
    return 200;
  } catch (error) {
    return error instanceof HttpError ? error.status : 500;
  }
};

describe('roles are independent permission sets (no hierarchy)', () => {
  it('a user holds exactly the roles granted to them, and nothing more', () => {
    const roleOf = {
      superAdmin: 'SUPER_ADMIN', orgAdmin: 'ORG_ADMIN', hospitalStaff: 'HOSPITAL_STAFF', doctor: 'DOCTOR',
      emergencyStaff: 'EMERGENCY_STAFF', bloodBankAdmin: 'BLOOD_BANK_ADMIN', bloodBankStaff: 'BLOOD_BANK_STAFF',
      inventoryManager: 'INVENTORY_MANAGER', donor: 'DONOR', publicRequester: 'PUBLIC_REQUESTER',
    } as const;
    for (const [key, own] of Object.entries(roleOf)) {
      const user = USERS[key as keyof typeof USERS];
      for (const role of ALL_ROLES) expect(hasRole(user, role), `${key} → ${role}`).toBe(role === own);
    }
  });

  it('BLOOD_BANK_ADMIN does not imply BLOOD_BANK_STAFF, and ORG_ADMIN does not imply a facility role', () => {
    expect(hasAnyRole(USERS.bloodBankAdmin, ['BLOOD_BANK_STAFF'])).toBe(false);
    expect(hasAnyRole(USERS.orgAdmin, ['BLOOD_BANK_ADMIN'], { facilityId: ID.centreA })).toBe(false);
  });
});

describe('facility scope', () => {
  it('a facility grant applies at that facility only', () => {
    expect(hasAnyRole(USERS.bloodBankAdmin, ['BLOOD_BANK_ADMIN'], { facilityId: ID.centreB })).toBe(true);
    expect(hasAnyRole(USERS.bloodBankAdmin, ['BLOOD_BANK_ADMIN'], { facilityId: ID.centreA })).toBe(false);
    expect(hasAnyRole(USERS.doctor, ['DOCTOR'], { facilityId: ID.abcHospital })).toBe(true);
    expect(hasAnyRole(USERS.doctor, ['DOCTOR'], { facilityId: ID.centreA })).toBe(false);
  });

  it('a facility grant does not give organization-level access to other facilities of the organization', () => {
    expect(canAccessFacility(USERS.doctor, ID.centreA)).toBe(false); // same organization, different facility
    expect(canAccessFacility(USERS.doctor, ID.abcHospital)).toBe(true);
  });

  it('ORG_ADMIN covers every facility of its own organization, but only through the ORG_ADMIN role', () => {
    expect(hasAnyRole(USERS.orgAdmin, ['ORG_ADMIN'], { facilityId: ID.abcHospital })).toBe(true);
    expect(hasAnyRole(USERS.orgAdmin, ['ORG_ADMIN'], { facilityId: ID.centreA })).toBe(true);
    expect(hasAnyRole(USERS.orgAdmin, ['ORG_ADMIN'], { facilityId: ID.centreB })).toBe(false); // other organization
    expect(accessibleFacilityIds(USERS.orgAdmin)).toEqual([ID.abcHospital, ID.centreA]);
  });
});

describe('organization scope and cross-organization denial', () => {
  it('members are recognised only in their own organization', () => {
    expect(isOrganizationMember(USERS.doctor, ID.orgAbc)).toBe(true);
    expect(isOrganizationMember(USERS.doctor, ID.orgCity)).toBe(false);
    expect(isOrganizationMember(USERS.bloodBankAdmin, ID.orgAbc)).toBe(false);
  });

  it('assertions deny other organizations (403) or hide them (404)', () => {
    expect(status(() => assertOrganizationAccess(USERS.bloodBankAdmin, ID.orgAbc))).toBe(403);
    expect(status(() => assertOrganizationAccess(USERS.bloodBankAdmin, ID.orgAbc, { hide: true }))).toBe(404);
    expect(status(() => assertFacilityAccess(USERS.bloodBankAdmin, ID.centreA))).toBe(403);
    expect(status(() => assertFacilityAccess(USERS.bloodBankAdmin, ID.centreA, { hide: true }))).toBe(404);
    expect(status(() => assertFacilityAccess(USERS.bloodBankAdmin, ID.centreB))).toBe(200);
    expect(status(() => assertOrganizationAccess(USERS.bloodBankAdmin, ID.orgCity))).toBe(200);
  });

  it('role-qualified assertions check the role at that scope', () => {
    expect(status(() => assertFacilityAccess(USERS.bloodBankStaff, ID.centreB, { roles: ['BLOOD_BANK_ADMIN'] }))).toBe(403);
    expect(status(() => assertFacilityAccess(USERS.bloodBankAdmin, ID.centreB, { roles: ['BLOOD_BANK_ADMIN'] }))).toBe(200);
    expect(status(() => assertOrganizationAccess(USERS.orgAdmin, ID.orgAbc, { roles: ['ORG_ADMIN'] }))).toBe(200);
    expect(status(() => assertOrganizationAccess(USERS.doctor, ID.orgAbc, { roles: ['ORG_ADMIN'] }))).toBe(403);
  });
});

describe('SUPER_ADMIN is not a wildcard', () => {
  it('holds the platform role, but passes no facility or organization scope check', () => {
    expect(isSuperAdmin(USERS.superAdmin)).toBe(true);
    expect(canAccessFacility(USERS.superAdmin, ID.centreA)).toBe(false);
    expect(isOrganizationMember(USERS.superAdmin, ID.orgAbc)).toBe(false);
    expect(status(() => assertFacilityAccess(USERS.superAdmin, ID.centreA))).toBe(403);
    expect(status(() => assertOrganizationAccess(USERS.superAdmin, ID.orgAbc))).toBe(403);
    expect(hasAnyRole(USERS.superAdmin, ['BLOOD_BANK_ADMIN'], { facilityId: ID.centreA })).toBe(false);
  });

  it('other roles are never super admins', () => {
    for (const [key, user] of Object.entries(USERS)) if (key !== 'superAdmin') expect(isSuperAdmin(user), key).toBe(false);
  });
});

describe.each([
  ['PUBLIC_REQUESTER', USERS.publicRequester],
  ['DONOR', USERS.donor],
])('%s (SELF scope) gains no broad access', (_name, user) => {
  it('has no organization or facility access of any kind', () => {
    for (const id of [ID.orgAbc, ID.orgCity]) {
      expect(isOrganizationMember(user, id)).toBe(false);
      expect(status(() => assertOrganizationAccess(user, id))).toBe(403);
    }
    for (const facility of Object.values(FACILITIES)) {
      expect(canAccessFacility(user, facility.id)).toBe(false);
      expect(status(() => assertFacilityAccess(user, facility.id))).toBe(403);
    }
    expect(accessibleFacilityIds(user)).toEqual([]);
  });

  it('cannot use any staff role, in any scope', () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'DONOR' && r !== 'PUBLIC_REQUESTER')) {
      expect(hasAnyRole(user, [role]), role).toBe(false);
      expect(hasAnyRole(user, [role], { facilityId: ID.abcHospital }), role).toBe(false);
      expect(hasAnyRole(user, [role], { organizationId: ID.orgAbc }), role).toBe(false);
    }
  });

  it('gains nothing even if a users.organization_id happens to be set', () => {
    const withOrg = context({
      organization: { id: ID.orgAbc, name: 'ABC', type: 'HOSPITAL' },
      grants: [selfGrant(user.grants[0]!.role)],
      facilities: [], // the loader only adds facilities from FACILITY grants / ORG_ADMIN
    });
    expect(isOrganizationMember(withOrg, ID.orgAbc)).toBe(false);
    expect(status(() => assertOrganizationAccess(withOrg, ID.orgAbc))).toBe(403);
    expect(status(() => assertFacilityAccess(withOrg, ID.abcHospital))).toBe(403);
  });
});

describe('authorization ignores everything except server-resolved grants', () => {
  it('a user with no grants can do nothing', () => {
    const nobody = context();
    for (const role of ALL_ROLES) expect(hasAnyRole(nobody, [role]), role).toBe(false);
    expect(status(() => assertOrganizationAccess(nobody, ID.orgAbc))).toBe(403);
  });

  it('two grants combine: a doctor who is also blood-bank staff elsewhere', () => {
    const both = context({
      grants: [facilityGrant('DOCTOR', ID.abcHospital, ID.orgAbc), facilityGrant('BLOOD_BANK_STAFF', ID.centreA, ID.orgAbc)],
      facilities: [FACILITIES.abcHospital, FACILITIES.centreA],
    });
    expect(hasAnyRole(both, ['DOCTOR'], { facilityId: ID.abcHospital })).toBe(true);
    expect(hasAnyRole(both, ['DOCTOR'], { facilityId: ID.centreA })).toBe(false);
    expect(hasAnyRole(both, ['BLOOD_BANK_STAFF'], { facilityId: ID.centreA })).toBe(true);
    expect(hasAnyRole(both, ['BLOOD_BANK_STAFF'], { facilityId: ID.abcHospital })).toBe(false);
  });
});
