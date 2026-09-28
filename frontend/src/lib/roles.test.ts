import { describe, expect, it } from 'vitest';
import type { Me } from '@/lib/auth';
import { visibleNavItems, workspaceFor } from '@/lib/roles';

const meWith = (roles: { role: string }[]): Me => ({
  user: { id: 'u1', email: 'a@b.invalid', fullName: 'A B' },
  organization: null,
  primaryFacilityId: null,
  roles: roles.map((r) => ({ ...r, scope: 'FACILITY', organizationId: null, facilityId: null })),
  facilities: [],
});

describe('workspaceFor', () => {
  it('is "none" before the identity has loaded', () => {
    expect(workspaceFor(null)).toBe('none');
  });

  it('is "staff" for every staff role this app connects to', () => {
    for (const role of ['ORG_ADMIN', 'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER', 'EMERGENCY_STAFF', 'HOSPITAL_STAFF', 'DOCTOR']) {
      expect(workspaceFor(meWith([{ role }]))).toBe('staff');
    }
  });

  it('is "donor" only when DONOR is the sole role', () => {
    expect(workspaceFor(meWith([{ role: 'DONOR' }]))).toBe('donor');
  });

  it('a DONOR who also holds a staff role gets the staff workspace — never a lesser one', () => {
    expect(workspaceFor(meWith([{ role: 'DONOR' }, { role: 'BLOOD_BANK_STAFF' }]))).toBe('staff');
  });

  it('is "none" for a role this phase does not connect to (e.g. PUBLIC_REQUESTER alone)', () => {
    expect(workspaceFor(meWith([{ role: 'PUBLIC_REQUESTER' }]))).toBe('none');
  });
});

describe('visibleNavItems', () => {
  it('a hospital-only identity (HOSPITAL_STAFF/DOCTOR) sees Overview and Requests (their own routine requests), not inventory/recommendations/donors', () => {
    const items = visibleNavItems(meWith([{ role: 'HOSPITAL_STAFF' }, { role: 'DOCTOR' }]));
    expect(items.map((i) => i.id).sort()).toEqual(['overview', 'requests'].sort());
  });

  it('a blood-centre admin sees inventory, recommendations and donors, plus requests (they can confirm holds)', () => {
    const items = visibleNavItems(meWith([{ role: 'BLOOD_BANK_ADMIN' }]));
    expect(items.map((i) => i.id).sort()).toEqual(['donors', 'inventory', 'overview', 'recommendations', 'requests'].sort());
  });

  it('emergency staff (no inventory role) see requests but not inventory/recommendations/donors', () => {
    const items = visibleNavItems(meWith([{ role: 'EMERGENCY_STAFF' }]));
    expect(items.map((i) => i.id).sort()).toEqual(['overview', 'requests'].sort());
  });

  it('never includes a link the backend has no route for', () => {
    const items = visibleNavItems(meWith([{ role: 'ORG_ADMIN' }]));
    expect(items.map((i) => i.id)).not.toEqual(expect.arrayContaining(['transfers', 'predictions', 'analytics', 'settings']));
  });
});
