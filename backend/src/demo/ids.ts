/**
 * Fixed, deterministic IDs for the DEMO_ONLY dataset (§12 of docs/03a_Database_Schema_Proposal.md).
 * Using fixed UUIDs — rather than `gen_random_uuid()` — is what makes the seed reproducible:
 * `resetDemoData()` deletes exactly these rows (plus everything that hangs off the demo facilities),
 * and re-seeding always produces the identical dataset. These are never used outside the demo seed.
 */
export const DEMO = {
  organizations: {
    abc: '00000000-0000-4000-a000-000000000001',
    cityBloodCentre: '00000000-0000-4000-a000-000000000002',
    sunrise: '00000000-0000-4000-a000-000000000003',
  },
  facilities: {
    abcHospital: '00000000-0000-4000-a000-000000000101',
    centreA: '00000000-0000-4000-a000-000000000102',
    centreB: '00000000-0000-4000-a000-000000000103',
    sunriseClinic: '00000000-0000-4000-a000-000000000104',
  },
  users: {
    abcOrgAdmin: '00000000-0000-4000-a000-000000000201',
    drSharma: '00000000-0000-4000-a000-000000000202',
    centreAAdmin: '00000000-0000-4000-a000-000000000203',
    centreAStaff: '00000000-0000-4000-a000-000000000204',
    centreBAdmin: '00000000-0000-4000-a000-000000000205',
    centreBStaff: '00000000-0000-4000-a000-000000000206',
    sunriseEmergencyStaff: '00000000-0000-4000-a000-000000000207',
  },
} as const;

/** `donors.id` for the 26th demo donor is DEMO.donorBase + 26, etc. — generated, not hand-listed. */
export const DEMO_DONOR_BASE = '00000000-0000-4000-a000-0000000003';
export const demoDonorId = (index: number) => `${DEMO_DONOR_BASE}${index.toString().padStart(2, '0')}`;

export const DEMO_FACILITY_IDS = Object.values(DEMO.facilities);
export const DEMO_ORGANIZATION_IDS = Object.values(DEMO.organizations);
