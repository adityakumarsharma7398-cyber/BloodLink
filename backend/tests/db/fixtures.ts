import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * TEST FIXTURES ONLY — built inside a transaction and rolled back (or in a throwaway database).
 * Compatibility rows are DEMO_ONLY test data, not clinical rules; the hold timeout is a test
 * value, not an approved planning parameter.
 */
export type BloodGroupCode = 'O-' | 'O+' | 'A-' | 'A+' | 'B-' | 'B+' | 'AB-' | 'AB+' | 'UNKNOWN';
export type ComponentCode = 'WHOLE_BLOOD' | 'PRBC' | 'PLASMA_FFP' | 'PLATELETS';

export interface Network {
  bg: Record<BloodGroupCode, number>;
  comp: Record<ComponentCode, number>;
  org: { abc: string; cbc: string; sunrise: string; metro: string };
  fac: { abcHospital: string; centreA: string; centreB: string; sunrise: string; metro: string };
  user: {
    drSharma: string; abcOrgAdmin: string; centreAAdmin: string; centreBAdmin: string; centreBStaff: string;
    sunriseStaff: string; metroStaff: string; publicUser: string; donorUser: string;
  };
}

const tag = () => randomUUID().slice(0, 8);

export async function buildNetwork(c: pg.Client): Promise<Network> {
  const t = tag();
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const id = async (sql: string, params: unknown[]) => (await q(sql, params))[0].id as string;

  const bg = Object.fromEntries((await q('select code, id from public.blood_groups')).map((r) => [r.code, r.id])) as Network['bg'];
  const comp = Object.fromEntries((await q('select code, id from public.components')).map((r) => [r.code, r.id])) as Network['comp'];

  const org = async (name: string, type: string, licence: string | null) =>
    id(`insert into public.organizations (name, type, licence_number, status, verified_at, shares_network_availability)
        values ($1, $2, $3, 'ACTIVE', now(), true) returning id`, [`${name} ${t}`, type, licence]);
  const facility = async (orgId: string, name: string, type: string, lat: number, lng: number, holds = false, holdsOk = false) =>
    id(`insert into public.facilities (organization_id, name, facility_type, holds_inventory, accepts_temporary_holds,
          address, city, state, latitude, longitude)
        values ($1, $2, $3, $4, $5, 'Test address', 'Lucknow', 'Uttar Pradesh', $6, $7) returning id`,
      [orgId, name, type, holds, holdsOk, lat, lng]);

  const abc = await org('ABC Hospital', 'HOSPITAL_BLOOD_CENTRE', 'LIC-ABC');
  const cbc = await org('City Blood Centre', 'BLOOD_CENTRE', 'LIC-CBC');
  const sunrise = await org('Sunrise Clinic', 'CLINIC', null);
  const metro = await org('Metro Hospital', 'HOSPITAL', null);

  const fac = {
    abcHospital: await facility(abc, 'ABC Hospital', 'HOSPITAL', 26.85, 80.95),
    centreA: await facility(abc, 'Centre A', 'BLOOD_CENTRE', 26.85, 80.95, true, true),
    centreB: await facility(cbc, 'Centre B', 'BLOOD_CENTRE', 26.9, 81.02, true, true),
    sunrise: await facility(sunrise, 'Sunrise Clinic', 'CLINIC', 26.87, 80.98),
    metro: await facility(metro, 'Metro Hospital', 'HOSPITAL', 26.86, 80.92, true, false),
  };

  const user = async (name: string, orgId: string | null, facilityId: string | null) => {
    const uid = randomUUID();
    const email = `${name.toLowerCase()}.${t}@test.bloodlink.invalid`;
    await q('insert into auth.users (id, email) values ($1, $2)', [uid, email]);
    await q(`insert into public.users (id, organization_id, facility_id, full_name, email, status)
             values ($1, $2, $3, $4, $5, 'ACTIVE')`, [uid, orgId, facilityId, name, email]);
    return uid;
  };
  const grant = (uid: string, role: string, orgId: string | null, facilityId: string | null) =>
    q(`insert into public.user_roles (user_id, role_id, organization_id, facility_id)
       select $1, id, $3, $4 from public.roles where code = $2`, [uid, role, orgId, facilityId]);

  const u = {
    drSharma: await user('DrSharma', abc, fac.abcHospital),
    abcOrgAdmin: await user('AbcAdmin', abc, null),
    centreAAdmin: await user('CentreAAdmin', abc, fac.centreA),
    centreBAdmin: await user('CentreBAdmin', cbc, fac.centreB),
    centreBStaff: await user('CentreBStaff', cbc, fac.centreB),
    sunriseStaff: await user('SunriseStaff', sunrise, fac.sunrise),
    metroStaff: await user('MetroStaff', metro, fac.metro),
    publicUser: await user('PublicUser', null, null),
    donorUser: await user('DonorUser', null, null),
  };
  await grant(u.drSharma, 'DOCTOR', abc, fac.abcHospital);
  await grant(u.drSharma, 'HOSPITAL_STAFF', abc, fac.abcHospital);
  await grant(u.abcOrgAdmin, 'ORG_ADMIN', abc, null);
  await grant(u.centreAAdmin, 'BLOOD_BANK_ADMIN', abc, fac.centreA);
  await grant(u.centreBAdmin, 'BLOOD_BANK_ADMIN', cbc, fac.centreB);
  await grant(u.centreBStaff, 'BLOOD_BANK_STAFF', cbc, fac.centreB);
  await grant(u.sunriseStaff, 'EMERGENCY_STAFF', sunrise, fac.sunrise);
  await grant(u.metroStaff, 'HOSPITAL_STAFF', metro, fac.metro);
  await grant(u.publicUser, 'PUBLIC_REQUESTER', null, null);
  await grant(u.donorUser, 'DONOR', null, null);

  return { bg, comp, org: { abc, cbc, sunrise, metro }, fac, user: u };
}

/** DEMO_ONLY identical-group PRBC test rows (never VALIDATED). */
export async function addDemoRules(c: pg.Client, n: Network, groups: BloodGroupCode[] = ['O-', 'O+']) {
  for (const g of groups) {
    await c.query(
      `insert into public.compatibility_rules (donor_blood_group_id, recipient_blood_group_id, component_id, compatible,
         priority, validation_status, validation_note)
       values ($1, $1, $2, true, 1, 'DEMO_ONLY', 'Test fixture — not clinically validated')
       on conflict do nothing`,
      [n.bg[g], n.comp.PRBC]);
  }
}

export async function setHoldTimeout(c: pg.Client, orgId: string, facilityId: string, minutes: number) {
  await c.query(
    `insert into public.planning_parameters (key, organization_id, facility_id, value, description)
     values ('allocation.hold_timeout_minutes', $1, $2, to_jsonb($3::numeric), 'test fixture')`,
    [orgId, facilityId, minutes]);
}

export async function addUnits(
  c: pg.Client, n: Network, facilityId: string, group: BloodGroupCode, count: number,
  opts: { status?: 'AVAILABLE' | 'QUARANTINED'; expiresInDays?: number; component?: ComponentCode } = {},
) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { rows } = await c.query(
      `select private.create_inventory_unit($1, $2, $3, $4, now() - interval '40 days',
         now() + make_interval(days => $5::int + $6::int), 'INVENTORY_ADDED', $7, null) as id`,
      [`T-${tag()}-${i}`, facilityId, n.comp[opts.component ?? 'PRBC'], n.bg[group], opts.expiresInDays ?? 20, i,
        opts.status ?? 'AVAILABLE']);
    ids.push(rows[0].id);
  }
  return ids;
}

/** An emergency request created by authorized Sunrise Clinic staff (self-verified, decision 2). */
export async function emergencyRequest(c: pg.Client, n: Network, quantity = 2, group: BloodGroupCode = 'O-') {
  const { rows } = await c.query(
    `insert into public.requests (requester_user_id, requester_facility_id, patient_facility_id, request_type, urgency,
       required_by, patient_reference, verification_status, verification_method, verified_by, verified_at)
     values ($1, $2, $2, 'EMERGENCY', 'CRITICAL', now() + interval '2 hours', 'CASE-TEST', 'VERIFIED',
       'STAFF_AT_CREATION', $1, now())
     returning id`,
    [n.user.sunriseStaff, n.fac.sunrise]);
  const requestId = rows[0].id as string;
  const item = await c.query(
    `insert into public.request_items (request_id, blood_group_id, component_id, quantity_requested, allow_compatible_substitutes)
     values ($1, $2, $3, $4, false) returning id`,
    [requestId, n.bg[group], n.comp.PRBC, quantity]);
  return { requestId, itemId: item.rows[0].id as string };
}
