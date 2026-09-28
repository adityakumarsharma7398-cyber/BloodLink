import { randomUUID } from 'node:crypto';
import type { AppRole, AuthContext, FacilityRef, Grant } from '../../src/auth/types.js';

/** Fixed ids so assertions read clearly. Two organizations, three facilities. */
export const ID = {
  orgAbc: '11111111-1111-4111-8111-111111111111',
  orgCity: '22222222-2222-4222-8222-222222222222',
  abcHospital: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  centreA: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  centreB: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
} as const;

export const FACILITIES: Record<'abcHospital' | 'centreA' | 'centreB', FacilityRef> = {
  abcHospital: { id: ID.abcHospital, name: 'ABC Hospital', organizationId: ID.orgAbc, facilityType: 'HOSPITAL' },
  centreA: { id: ID.centreA, name: 'Centre A', organizationId: ID.orgAbc, facilityType: 'BLOOD_CENTRE' },
  centreB: { id: ID.centreB, name: 'Centre B', organizationId: ID.orgCity, facilityType: 'BLOOD_CENTRE' },
};

export function context(overrides: Partial<AuthContext> & { grants?: Grant[] } = {}): AuthContext {
  return {
    userId: randomUUID(),
    email: 'user@test.invalid',
    fullName: 'Test User',
    organization: null,
    primaryFacilityId: null,
    grants: [],
    facilities: [],
    ...overrides,
  };
}

export const facilityGrant = (role: AppRole, facilityId: string, organizationId: string): Grant => ({
  role, scope: 'FACILITY', organizationId, facilityId,
});
export const orgGrant = (role: AppRole, organizationId: string): Grant => ({ role, scope: 'ORGANIZATION', organizationId, facilityId: null });
export const selfGrant = (role: AppRole): Grant => ({ role, scope: 'SELF', organizationId: null, facilityId: null });
export const platformGrant = (role: AppRole): Grant => ({ role, scope: 'PLATFORM', organizationId: null, facilityId: null });

/** One user per approved role, each in the smallest scope the database allows. */
export const USERS = {
  superAdmin: context({ grants: [platformGrant('SUPER_ADMIN')] }),
  orgAdmin: context({
    organization: { id: ID.orgAbc, name: 'ABC', type: 'HOSPITAL_BLOOD_CENTRE' },
    grants: [orgGrant('ORG_ADMIN', ID.orgAbc)],
    facilities: [FACILITIES.abcHospital, FACILITIES.centreA],
  }),
  hospitalStaff: context({
    organization: { id: ID.orgAbc, name: 'ABC', type: 'HOSPITAL_BLOOD_CENTRE' },
    grants: [facilityGrant('HOSPITAL_STAFF', ID.abcHospital, ID.orgAbc)],
    facilities: [FACILITIES.abcHospital],
  }),
  doctor: context({
    organization: { id: ID.orgAbc, name: 'ABC', type: 'HOSPITAL_BLOOD_CENTRE' },
    grants: [facilityGrant('DOCTOR', ID.abcHospital, ID.orgAbc)],
    facilities: [FACILITIES.abcHospital],
  }),
  emergencyStaff: context({
    organization: { id: ID.orgAbc, name: 'ABC', type: 'HOSPITAL_BLOOD_CENTRE' },
    grants: [facilityGrant('EMERGENCY_STAFF', ID.abcHospital, ID.orgAbc)],
    facilities: [FACILITIES.abcHospital],
  }),
  bloodBankAdmin: context({
    organization: { id: ID.orgCity, name: 'City', type: 'BLOOD_CENTRE' },
    grants: [facilityGrant('BLOOD_BANK_ADMIN', ID.centreB, ID.orgCity)],
    facilities: [FACILITIES.centreB],
  }),
  bloodBankStaff: context({
    organization: { id: ID.orgCity, name: 'City', type: 'BLOOD_CENTRE' },
    grants: [facilityGrant('BLOOD_BANK_STAFF', ID.centreB, ID.orgCity)],
    facilities: [FACILITIES.centreB],
  }),
  inventoryManager: context({
    organization: { id: ID.orgAbc, name: 'ABC', type: 'HOSPITAL_BLOOD_CENTRE' },
    grants: [facilityGrant('INVENTORY_MANAGER', ID.centreA, ID.orgAbc)],
    facilities: [FACILITIES.centreA],
  }),
  donor: context({ grants: [selfGrant('DONOR')] }),
  publicRequester: context({ grants: [selfGrant('PUBLIC_REQUESTER')] }),
} as const;
