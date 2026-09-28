import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { DEMO, DEMO_FACILITY_IDS, DEMO_ORGANIZATION_IDS, demoDonorId } from './ids.js';

/**
 * DEMO_ONLY dataset (docs/03a_Database_Schema_Proposal.md §12). Seeds only FACTS — organizations,
 * facilities, users, reference-linked inventory, historical ledger, donors and requests. It never
 * writes `predictions`, `alerts` or `recommendations` directly (requirement 9 / U2): those are
 * produced by calling the real `/api/intelligence/*` and `/api/donor-activations/runs` endpoints
 * afterwards, exactly as any other caller would.
 *
 * Every write goes through the same private functions and triggers real workflows use
 * (`private.create_inventory_unit`, `private.place_source_hold`, `private.confirm_hold`, the
 * `donations_refresh_donor` trigger, …) — nothing here bypasses a guard trigger, RLS or the audit
 * log. The one deliberate exception is documented at `createHistoricalIssuedUnit()` below:
 * historical consumption needs ledger rows dated in the past, and no private function exposes
 * that (by design — a live system should never backdate a real event). Backdating uses exactly
 * the session-local flag (`bloodlink.unit_write`) the private functions themselves use, so the
 * guard trigger's actual invariant (writes are privileged, not: this timestamp is "now") is still
 * upheld.
 *
 * Shelf life (`SHELF_LIFE_DAYS`) is a value this seed script declares openly for generating
 * plausible expiry dates — never written into `components`, never presented as clinical
 * reference data (decision U8).
 *
 * **Reproducibility and `public.transactions` (§8, requirement 8):** the ledger is append-only —
 * `insert`-only by design (`private.transactions_guard`, migration 003), and inventory units carry
 * an `on delete restrict` foreign key to it. That is exactly what makes the ledger trustworthy,
 * and this seed does not weaken it. Two consequences:
 *   - `seedDemoData()` is idempotent by CHECKING first, not by deleting and recreating: if the
 *     demo organizations already exist, it refuses with a clear error rather than partially
 *     overwriting live data — seeding a fresh database always produces the identical dataset, and
 *     re-running it against the same database fails safely instead of silently rewriting it.
 *   - `resetDemoData()` removes only what is genuinely safe to remove, best-effort: it never
 *     succeeds at removing a row that a permanent one now references (a recommendation a transfer
 *     points at, a user who has acted on a permanent row), and it never even attempts organizations,
 *     facilities, inventory units, requests, donors, audit logs or the ledger — the same guarantee
 *     that protects a real deployment's audit trail. To start
 *     completely over, seed a fresh local/demo database instead of resetting a live one.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_COMPATIBILITY_SEED = path.resolve(here, '../../../supabase/seed/001_demo_compatibility_rules.sql');

// Demo-only shelf-life assumption for generating expiry dates (not a clinical reference value).
const SHELF_LIFE_DAYS = 42;
const HISTORY_DAYS = 30;
const IST_OFFSET_MINUTES = 330;

const istNoonUtc = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000 - IST_OFFSET_MINUTES * 60_000);

export interface DemoSummary {
  organizations: { id: string; name: string }[];
  facilities: { id: string; name: string; organizationId: string }[];
  users: { id: string; email: string; roles: string[] }[];
  donors: { total: number; eligibleForActivation: number };
  requests: { id: string; requestNumber: string; status: string }[];
  historicalUnitsIssued: number;
  bloodGroups: Record<string, number>;
  components: Record<string, number>;
}

/**
 * Removes whatever of the derived/decision and configuration layers (predictions, recommendations,
 * alerts, donor activations, planning parameters, the demo users) is not — or is no longer —
 * referenced by a permanent row. Once real workflow activity has run against the demo dataset, some
 * of these stop being freely deletable: a recommendation that a transfer or request allocation now
 * points at cannot be removed (the same guard triggers that make the ledger append-only block
 * nulling out their `recommendation_id`), and a user who has acted (`initiated_by`, `recorded_by`,
 * `activated_by`, `decided_by`, …) on a permanent row cannot be removed either, by an ordinary
 * foreign key. Each group below is attempted in its own transaction and is allowed to no-op —
 * never to abort the rest — when it hits one of those references; `planning_parameters` has no
 * incoming reference from anything and always succeeds. It deliberately never touches
 * organizations, facilities, inventory units, the ledger, audit logs, requests or donors — see the
 * module doc comment for why. Safe to call on an unseeded database, and safe to call repeatedly.
 */
export async function resetDemoData(client: pg.Client): Promise<void> {
  const facilityIds = DEMO_FACILITY_IDS;
  const orgIds = DEMO_ORGANIZATION_IDS;
  const userIds = Object.values(DEMO.users);

  const attempt = async (run: () => Promise<void>) => {
    await client.query('begin');
    try {
      await run();
      await client.query('commit');
    } catch {
      await client.query('rollback'); // a permanent row still references this group — leave it, this reset is best-effort here
    }
  };

  await attempt(async () => {
    await client.query("select set_config('bloodlink.allocation_write', 'on', true)");
    await client.query('delete from public.donor_activation_recipients where activation_id in (select id from public.donor_activations where facility_id = any($1::uuid[]))', [facilityIds]);
    await client.query('delete from public.donor_activations where facility_id = any($1::uuid[])', [facilityIds]);
    await client.query('delete from public.recommendations where organization_id = any($1::uuid[])', [orgIds]);
    await client.query('delete from public.predictions where organization_id = any($1::uuid[])', [orgIds]);
    await client.query('delete from public.alerts where organization_id = any($1::uuid[])', [orgIds]);
    await client.query("select set_config('bloodlink.allocation_write', '', true)");
  });

  // Guaranteed: nothing references planning_parameters.
  await client.query('begin');
  await client.query('delete from public.planning_parameters where organization_id = any($1::uuid[]) or (organization_id is null and description = $2)', [orgIds, 'DEMO_ONLY seed']);
  await client.query('commit');

  await attempt(() => client.query('delete from public.user_roles where organization_id = any($1::uuid[]) or user_id = any($2::uuid[])', [orgIds, userIds]).then(() => undefined));
  await attempt(() => client.query('delete from public.users where id = any($1::uuid[])', [userIds]).then(() => undefined));
  await attempt(() => client.query('delete from auth.users where id = any($1::uuid[])', [userIds]).then(() => undefined));
}

async function ids(client: pg.Client, table: 'blood_groups' | 'components'): Promise<Record<string, number>> {
  const { rows } = await client.query(`select code, id from public.${table}`);
  return Object.fromEntries(rows.map((row: { code: string; id: number }) => [row.code, row.id]));
}

/** Creates one AVAILABLE/QUARANTINED unit through the real lifecycle function (INVENTORY_ADDED). */
async function createUnit(
  client: pg.Client,
  args: { unitCode: string; facilityId: string; componentId: number; bloodGroupId: number; collectionDate: Date; expiryDate: Date; status: 'AVAILABLE' | 'QUARANTINED' },
): Promise<string> {
  const { rows } = await client.query(
    `select private.create_inventory_unit($1, $2, $3, $4, $5, $6, 'INVENTORY_ADDED', $7, null) as id`,
    [args.unitCode, args.facilityId, args.componentId, args.bloodGroupId, args.collectionDate.toISOString(), args.expiryDate.toISOString(), args.status],
  );
  return rows[0].id as string;
}

/**
 * Records a historical AVAILABLE → ISSUED consumption event dated in the past, so
 * `public.v_daily_consumption` (and the demand forecast built from it) sees real multi-week
 * history. See the module doc comment for why this cannot go through
 * `private.transition_unit_status()` (it always timestamps "now").
 */
/**
 * Creates one already-ISSUED unit whose ledger is dated in the past: a creation event followed by
 * an issue event, both backdated (the creation event must sort before the issue event, or "the
 * unit's latest transaction matches its current status" — a real consistency check, not seeded —
 * would fail). Both writes use the exact session flag `private.create_inventory_unit()` /
 * `private.transition_unit_status()` use internally; see the module doc comment for why this
 * narrow exception exists instead of calling those functions (which always timestamp "now").
 */
async function createHistoricalIssuedUnit(
  client: pg.Client,
  args: { unitCode: string; facilityId: string; bloodGroupId: number; componentId: number; collectionDate: Date; expiryDate: Date; issuedAt: Date; actorId: string },
): Promise<string> {
  await client.query("select set_config('bloodlink.unit_write', 'on', true)");
  const { rows: unitRows } = await client.query(
    `insert into public.inventory_units (unit_code, facility_id, component_id, blood_group_id, collection_date, expiry_date, status, status_changed_at, received_at)
     values ($1, $2, $3, $4, $5, $6, 'ISSUED', $7, $5) returning id`,
    [args.unitCode, args.facilityId, args.componentId, args.bloodGroupId, args.collectionDate.toISOString(), args.expiryDate.toISOString(), args.issuedAt.toISOString()],
  );
  const unitId = unitRows[0].id as string;
  const createdAt = new Date(args.issuedAt.getTime() - 60 * 60_000); // one hour before the issue event
  await client.query(
    `insert into public.transactions (transaction_type, facility_id, inventory_unit_id, blood_group_id, component_id, from_status, to_status, recorded_by, occurred_at, note)
     values ('INVENTORY_ADDED', $1, $2, $3, $4, null, 'AVAILABLE', $5, $6, 'demo seed: backdated historical unit')`,
    [args.facilityId, unitId, args.bloodGroupId, args.componentId, args.actorId, createdAt.toISOString()],
  );
  await client.query(
    `insert into public.transactions (transaction_type, facility_id, inventory_unit_id, blood_group_id, component_id, from_status, to_status, recorded_by, occurred_at, note)
     values ('INVENTORY_ISSUED', $1, $2, $3, $4, 'AVAILABLE', 'ISSUED', $5, $6, 'demo seed: backdated historical consumption')`,
    [args.facilityId, unitId, args.bloodGroupId, args.componentId, args.actorId, args.issuedAt.toISOString()],
  );
  await client.query("select set_config('bloodlink.unit_write', '', true)");
  return unitId;
}

/** One issued unit per day for `days`, `unitsPerDay(dayIndex)` units on that day (oldest day first). */
async function seedHistory(
  client: pg.Client,
  args: { facilityId: string; bloodGroupId: number; componentId: number; actorId: string; days: number; unitsPerDay: (dayIndex: number) => number; tag: string },
): Promise<number> {
  let created = 0;
  for (let day = args.days - 1; day >= 0; day -= 1) {
    const dayIndex = args.days - 1 - day; // 0 = oldest
    const occurredAt = istNoonUtc(day);
    const count = args.unitsPerDay(dayIndex);
    for (let i = 0; i < count; i += 1) {
      await createHistoricalIssuedUnit(client, {
        unitCode: `DEMO-HIST-${args.tag}-${day}-${i}`,
        facilityId: args.facilityId,
        componentId: args.componentId,
        bloodGroupId: args.bloodGroupId,
        collectionDate: new Date(occurredAt.getTime() - 2 * 60 * 60_000),
        expiryDate: new Date(occurredAt.getTime() + SHELF_LIFE_DAYS * 86_400_000),
        issuedAt: occurredAt,
        actorId: args.actorId,
      });
      created += 1;
    }
  }
  return created;
}

async function param(client: pg.Client, key: string, value: unknown, scope: { organizationId?: string | null; facilityId?: string | null } = {}): Promise<void> {
  await client.query(
    `insert into public.planning_parameters (key, organization_id, facility_id, value, description)
     values ($1, $2, $3, $4::jsonb, 'DEMO_ONLY seed')`,
    [key, scope.organizationId ?? null, scope.facilityId ?? null, JSON.stringify(value)],
  );
}

export async function seedDemoData(client: pg.Client): Promise<DemoSummary> {
  // Fails fast and clearly rather than partially overwriting a live database: the ledger this seed
  // writes can never be deleted once real activity has been recorded against it (see the module doc
  // comment), so this function only knows how to create the dataset once, against a database that
  // does not have it yet. Run it against a fresh local/demo database; do not call it twice against
  // the same one. `resetDemoData()` clears the derived/config layer for repeated *testing* of that
  // layer, but does not make this function safe to call twice.
  const existing = await client.query('select 1 from public.organizations where id = $1', [DEMO.organizations.abc]);
  if ((existing.rowCount ?? 0) > 0) {
    throw new Error('Demo dataset already exists (organizations.id = DEMO.organizations.abc). Seed a fresh database instead of re-seeding this one.');
  }
  const bg = await ids(client, 'blood_groups');
  const comp = await ids(client, 'components');
  const { abc, cityBloodCentre, sunrise } = DEMO.organizations;
  const { abcHospital, centreA, centreB, sunriseClinic } = DEMO.facilities;
  const u = DEMO.users;

  await client.query('begin');
  try {
    // ---- Organizations & facilities (§12.2) --------------------------------------------------
    const org = (id: string, name: string, type: string, licence: string) =>
      client.query(
        `insert into public.organizations (id, name, type, licence_number, status, verified_at, shares_network_availability)
         values ($1, $2, $3, $4, 'ACTIVE', now(), true)`,
        [id, name, type, licence],
      );
    await org(abc, 'ABC Hospital', 'HOSPITAL_BLOOD_CENTRE', 'DEMO-LIC-ABC');
    await org(cityBloodCentre, 'City Blood Centre', 'BLOOD_CENTRE', 'DEMO-LIC-CBC');
    await org(sunrise, 'Sunrise Clinic', 'CLINIC', 'DEMO-LIC-SUN');

    const facility = (id: string, orgId: string, name: string, type: string, holds: boolean, holdsTemp: boolean, lat: number, lng: number) =>
      client.query(
        `insert into public.facilities (id, organization_id, name, facility_type, holds_inventory, accepts_temporary_holds, address, city, state, latitude, longitude)
         values ($1, $2, $3, $4, $5, $6, 'Demo address', 'Lucknow', 'Uttar Pradesh', $7, $8)`,
        [id, orgId, name, type, holds, holdsTemp, lat, lng],
      );
    await facility(abcHospital, abc, 'ABC Hospital', 'HOSPITAL', false, false, 26.85, 80.95);
    await facility(centreA, abc, 'Centre A', 'BLOOD_CENTRE', true, true, 26.85, 80.95);
    await facility(centreB, cityBloodCentre, 'Centre B', 'BLOOD_CENTRE', true, true, 26.9, 81.02);
    await facility(sunriseClinic, sunrise, 'Sunrise Clinic', 'CLINIC', false, false, 26.87, 80.98);

    // ---- Users & roles (§12.3) ----------------------------------------------------------------
    const user = async (id: string, name: string, email: string, orgId: string | null, facilityId: string | null) => {
      await client.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
      await client.query(
        `insert into public.users (id, organization_id, facility_id, full_name, email, status) values ($1, $2, $3, $4, $5, 'ACTIVE')`,
        [id, orgId, facilityId, name, email],
      );
    };
    const grant = (userId: string, role: string, orgId: string | null, facilityId: string | null) =>
      client.query(
        `insert into public.user_roles (user_id, role_id, organization_id, facility_id) select $1, id, $3, $4 from public.roles where code = $2::text::public.app_role`,
        [userId, role, orgId, facilityId],
      );

    await user(u.abcOrgAdmin, 'ABC Org Admin', 'demo-abc-admin@bloodlink.invalid', abc, null);
    await grant(u.abcOrgAdmin, 'ORG_ADMIN', abc, null);
    await user(u.drSharma, 'Dr. Sharma', 'demo-dr-sharma@bloodlink.invalid', abc, abcHospital);
    await grant(u.drSharma, 'DOCTOR', abc, abcHospital);
    await grant(u.drSharma, 'HOSPITAL_STAFF', abc, abcHospital);
    await user(u.centreAAdmin, 'Centre A Admin', 'demo-centre-a-admin@bloodlink.invalid', abc, centreA);
    await grant(u.centreAAdmin, 'BLOOD_BANK_ADMIN', abc, centreA);
    await user(u.centreAStaff, 'Centre A Inventory', 'demo-centre-a-staff@bloodlink.invalid', abc, centreA);
    await grant(u.centreAStaff, 'INVENTORY_MANAGER', abc, centreA);
    await grant(u.centreAStaff, 'BLOOD_BANK_STAFF', abc, centreA);
    await user(u.centreBAdmin, 'Centre B Admin', 'demo-centre-b-admin@bloodlink.invalid', cityBloodCentre, centreB);
    await grant(u.centreBAdmin, 'BLOOD_BANK_ADMIN', cityBloodCentre, centreB);
    await user(u.centreBStaff, 'Centre B Staff', 'demo-centre-b-staff@bloodlink.invalid', cityBloodCentre, centreB);
    await grant(u.centreBStaff, 'BLOOD_BANK_STAFF', cityBloodCentre, centreB);
    await user(u.sunriseEmergencyStaff, 'Sunrise Emergency Staff', 'demo-sunrise-staff@bloodlink.invalid', sunrise, sunriseClinic);
    await grant(u.sunriseEmergencyStaff, 'EMERGENCY_STAFF', sunrise, sunriseClinic);

    // ---- Planning parameters (§12.5 — values declared here, never invented downstream) --------
    await param(client, 'forecast.history_days', HISTORY_DAYS, { organizationId: abc });
    await param(client, 'forecast.horizon_days', 14, { organizationId: abc });
    await param(client, 'coverage.target_days', 5, { organizationId: abc });
    await param(client, 'coverage.risk_bands', { criticalBelowDays: 3, highBelowDays: 5, mediumBelowDays: 10 }, { organizationId: abc });
    await param(client, 'expiry.warning_days', 7, { organizationId: abc });
    await param(client, 'transfer.min_units', 1, { organizationId: abc });
    await param(client, 'transfer.max_units', 30, { organizationId: abc });
    await param(client, 'donor.search_radius_km', 10, { organizationId: abc });
    await param(client, 'donor.min_interval_days', 90, { organizationId: abc });
    await param(client, 'allocation.hold_timeout_minutes', 30, { organizationId: abc, facilityId: centreA });

    await param(client, 'forecast.history_days', HISTORY_DAYS, { organizationId: cityBloodCentre });
    await param(client, 'forecast.horizon_days', 14, { organizationId: cityBloodCentre });
    await param(client, 'reserve.floor_days', 5, { organizationId: cityBloodCentre });
    await param(client, 'reserve.floor_days', 5, { organizationId: abc }); // symmetric — Centre A may itself act as a source for other groups
    await param(client, 'expiry.warning_days', 7, { organizationId: cityBloodCentre });
    await param(client, 'allocation.hold_timeout_minutes', 30, { organizationId: cityBloodCentre, facilityId: centreB });

    // Network-wide (organization_id = null): the mock Maps adapter's ETA parameters.
    await param(client, 'eta.road_factor', 1.3, {});
    await param(client, 'eta.urban_speed_kmh', 25, {});

    // ---- Demo compatibility rules (existing, reviewed file — applied here, not duplicated) ----
    await client.query(readFileSync(DEMO_COMPATIBILITY_SEED, 'utf8'));

    // ---- Historical consumption (§12.4 — drives the forecast) ----------------------------------
    // Centre A, O− PRBC: a genuine rising trend, 3 → 5 units/day; baseline average = 4.0/day exactly.
    const centreAONegHistory = await seedHistory(client, {
      facilityId: centreA, bloodGroupId: bg['O-']!, componentId: comp.PRBC!, actorId: u.centreAStaff,
      days: HISTORY_DAYS, unitsPerDay: (i) => 3 + Math.floor(i / 10), tag: 'centreA-Oneg',
    });
    // Centre A, A+ PRBC: flat, light demand — the "healthy" series.
    const centreAAPosHistory = await seedHistory(client, {
      facilityId: centreA, bloodGroupId: bg['A+']!, componentId: comp.PRBC!, actorId: u.centreAStaff,
      days: HISTORY_DAYS, unitsPerDay: () => 1, tag: 'centreA-Apos',
    });
    // Centre B, O− PRBC: flat, light demand — a genuine surplus source relative to Centre A's need.
    const centreBONegHistory = await seedHistory(client, {
      facilityId: centreB, bloodGroupId: bg['O-']!, componentId: comp.PRBC!, actorId: u.centreBStaff,
      days: HISTORY_DAYS, unitsPerDay: () => 1, tag: 'centreB-Oneg',
    });

    // ---- Current stock (§12.5) -----------------------------------------------------------------
    const farExpiry = new Date(Date.now() + 30 * 86_400_000);
    const soonExpiry = (days: number) => new Date(Date.now() + days * 86_400_000);
    const today = new Date();

    // Centre A, O− PRBC: 16 usable (3 expiring within 7 days) + 4 that become a confirmed hold + 2 incoming.
    const centreAONegAvailable: string[] = [];
    for (let i = 0; i < 13; i += 1) {
      centreAONegAvailable.push(await createUnit(client, { unitCode: `DEMO-A-ONEG-${i}`, facilityId: centreA, componentId: comp.PRBC!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: farExpiry, status: 'AVAILABLE' }));
    }
    for (let i = 0; i < 3; i += 1) {
      centreAONegAvailable.push(await createUnit(client, { unitCode: `DEMO-A-ONEG-SOON-${i}`, facilityId: centreA, componentId: comp.PRBC!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: soonExpiry(5), status: 'AVAILABLE' }));
    }
    const centreAONegForHold: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      // Earliest expiry of all Centre A O− PRBC stock, so private.place_source_hold's first-expiry-first
      // selection reserves exactly these 4 — leaving the 16 "usable" units (13 normal + 3 near-expiry) alone.
      centreAONegForHold.push(await createUnit(client, { unitCode: `DEMO-A-ONEG-HOLD-${i}`, facilityId: centreA, componentId: comp.PRBC!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: soonExpiry(3), status: 'AVAILABLE' }));
    }
    for (let i = 0; i < 2; i += 1) {
      await createUnit(client, { unitCode: `DEMO-A-ONEG-QTN-${i}`, facilityId: centreA, componentId: comp.PRBC!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: farExpiry, status: 'QUARANTINED' });
    }

    // Centre A, A+ PRBC: ~30 usable, well above its light demand — the healthy series.
    for (let i = 0; i < 30; i += 1) {
      await createUnit(client, { unitCode: `DEMO-A-APOS-${i}`, facilityId: centreA, componentId: comp.PRBC!, bloodGroupId: bg['A+']!, collectionDate: today, expiryDate: farExpiry, status: 'AVAILABLE' });
    }
    // Every other supported component, both at Centre A, for coverage (no history — reported UNKNOWN, never invented).
    for (const code of ['WHOLE_BLOOD', 'PLASMA_FFP', 'PLATELETS']) {
      for (let i = 0; i < 3; i += 1) {
        await createUnit(client, { unitCode: `DEMO-A-${code}-${i}`, facilityId: centreA, componentId: comp[code]!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: farExpiry, status: 'AVAILABLE' });
      }
    }

    // Centre B, O− PRBC: 32 usable, 6 expiring within 3 days — a genuine surplus with some near-expiry stock.
    for (let i = 0; i < 26; i += 1) {
      await createUnit(client, { unitCode: `DEMO-B-ONEG-${i}`, facilityId: centreB, componentId: comp.PRBC!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: farExpiry, status: 'AVAILABLE' });
    }
    for (let i = 0; i < 6; i += 1) {
      await createUnit(client, { unitCode: `DEMO-B-ONEG-SOON-${i}`, facilityId: centreB, componentId: comp.PRBC!, bloodGroupId: bg['O-']!, collectionDate: today, expiryDate: soonExpiry(3), status: 'AVAILABLE' });
    }
    // A couple of other groups/components at Centre B, for variety.
    for (const [group, count] of [['O+', 10] as const, ['B+', 8] as const]) {
      for (let i = 0; i < count; i += 1) {
        await createUnit(client, { unitCode: `DEMO-B-${group}-${i}`, facilityId: centreB, componentId: comp.PRBC!, bloodGroupId: bg[group]!, collectionDate: today, expiryDate: farExpiry, status: 'AVAILABLE' });
      }
    }

    // ---- Requests (§12.5: reserved=4 via a confirmed hold; pending=2, open) --------------------
    const requestNumbers: { id: string; requestNumber: string; status: string }[] = [];
    const insertRequest = async (
      requesterId: string, facilityId: string, urgency: string, quantity: number, groupCode: string, componentCode: string,
    ) => {
      const { rows } = await client.query(
        `insert into public.requests (requester_user_id, requester_facility_id, patient_facility_id, request_type, urgency,
           required_by, verification_status, verification_method, verified_by, verified_at)
         values ($1, $2, $2, 'ROUTINE', $3, now() + interval '2 days', 'VERIFIED', 'STAFF_AT_CREATION', $1, now())
         returning id, request_number, status`,
        [requesterId, facilityId, urgency],
      );
      const request = rows[0] as { id: string; request_number: string; status: string };
      const { rows: itemRows } = await client.query(
        `insert into public.request_items (request_id, blood_group_id, component_id, quantity_requested, allow_compatible_substitutes)
         values ($1, $2, $3, $4, false) returning id`,
        [request.id, bg[groupCode], comp[componentCode], quantity],
      );
      return { requestId: request.id as string, requestNumber: request.request_number as string, itemId: itemRows[0].id as string, status: request.status as string };
    };

    const reservedRequest = await insertRequest(u.drSharma, abcHospital, 'NORMAL', 4, 'O-', 'PRBC');
    const allocations = await client.query(
      // p_allow_demo_rules = true: only DEMO_ONLY compatibility rules exist in this dataset (requirement 3/4).
      `select private.place_source_hold($1, $2, $3, $4, true) as allocation_id`,
      [reservedRequest.itemId, centreA, 4, u.centreAAdmin],
    );
    await client.query(
      'select private.confirm_hold($1::uuid[], $2)',
      [allocations.rows.map((r: { allocation_id: string }) => r.allocation_id), u.centreAAdmin],
    );
    requestNumbers.push({ id: reservedRequest.requestId, requestNumber: reservedRequest.requestNumber, status: 'ALLOCATED' });

    const openRequest = await insertRequest(u.drSharma, abcHospital, 'NORMAL', 2, 'O-', 'PRBC');
    requestNumbers.push({ id: openRequest.requestId, requestNumber: openRequest.requestNumber, status: 'OPEN' });

    // ---- Donors (§12.5: 12 eligible, 6 deliberately excluded, plus other-group donors) ---------
    let donorIndex = 0;
    let eligibleCount = 0;
    const donor = async (args: {
      name: string; groupCode: string; lat: number; lng: number; consent: boolean; status: string; availability: string; lastDonationDaysAgo: number | null;
    }) => {
      donorIndex += 1;
      const id = demoDonorId(donorIndex);
      const email = `demo-donor-${donorIndex}@bloodlink.invalid`;
      await client.query(
        `insert into public.donors (id, full_name, blood_group_id, phone, email, latitude, longitude, availability_status, status, consent_to_contact)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, args.name, bg[args.groupCode], '9800000000', email, args.lat, args.lng, args.availability, args.status, args.consent],
      );
      if (args.lastDonationDaysAgo !== null) {
        const donationDate = new Date(Date.now() - args.lastDonationDaysAgo * 86_400_000);
        await client.query(
          `insert into public.donations (donor_id, facility_id, donation_type, donation_date, volume_ml, screening_status, eligibility_status, recorded_by)
           values ($1, $2, 'WHOLE_BLOOD', $3, 450, 'PASSED', 'ELIGIBLE', $4)`,
          [id, centreA, donationDate.toISOString(), u.centreAStaff],
        );
      }
      return id;
    };

    // 12 eligible: consenting, ACTIVE, AVAILABLE, within 10 km of Centre A (26.85, 80.95), donated > 120 days ago.
    for (let i = 0; i < 12; i += 1) {
      await donor({
        name: `Demo Donor E${i + 1}`, groupCode: 'O-', lat: 26.85 + (i % 4) * 0.01, lng: 80.95 + Math.floor(i / 4) * 0.01,
        consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 130,
      });
      eligibleCount += 1;
    }
    // 6 deliberately excluded, one per reason:
    await donor({ name: 'Demo Donor Far 1', groupCode: 'O-', lat: 27.3, lng: 81.4, consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 130 });
    await donor({ name: 'Demo Donor Far 2', groupCode: 'O-', lat: 27.35, lng: 81.45, consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 130 });
    await donor({ name: 'Demo Donor Far 3', groupCode: 'O-', lat: 27.4, lng: 81.5, consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 130 });
    await donor({ name: 'Demo Donor Recent 1', groupCode: 'O-', lat: 26.86, lng: 80.96, consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 30 });
    await donor({ name: 'Demo Donor Recent 2', groupCode: 'O-', lat: 26.86, lng: 80.94, consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 20 });
    await donor({ name: 'Demo Donor Unavailable', groupCode: 'O-', lat: 26.85, lng: 80.95, consent: true, status: 'ACTIVE', availability: 'UNAVAILABLE', lastDonationDaysAgo: 130 });
    await donor({ name: 'Demo Donor No Consent', groupCode: 'O-', lat: 26.85, lng: 80.95, consent: false, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 130 });

    // A handful of other-group donors, for variety (not part of the O− PRBC activation story).
    for (const groupCode of ['A+', 'B+', 'AB+', 'O+']) {
      await donor({ name: `Demo Donor ${groupCode}`, groupCode, lat: 26.85, lng: 80.95, consent: true, status: 'ACTIVE', availability: 'AVAILABLE', lastDonationDaysAgo: 130 });
    }

    await client.query('commit');

    return {
      organizations: [
        { id: abc, name: 'ABC Hospital' }, { id: cityBloodCentre, name: 'City Blood Centre' }, { id: sunrise, name: 'Sunrise Clinic' },
      ],
      facilities: [
        { id: abcHospital, name: 'ABC Hospital', organizationId: abc }, { id: centreA, name: 'Centre A', organizationId: abc },
        { id: centreB, name: 'Centre B', organizationId: cityBloodCentre }, { id: sunriseClinic, name: 'Sunrise Clinic', organizationId: sunrise },
      ],
      users: [
        { id: u.abcOrgAdmin, email: 'demo-abc-admin@bloodlink.invalid', roles: ['ORG_ADMIN'] },
        { id: u.drSharma, email: 'demo-dr-sharma@bloodlink.invalid', roles: ['DOCTOR', 'HOSPITAL_STAFF'] },
        { id: u.centreAAdmin, email: 'demo-centre-a-admin@bloodlink.invalid', roles: ['BLOOD_BANK_ADMIN'] },
        { id: u.centreAStaff, email: 'demo-centre-a-staff@bloodlink.invalid', roles: ['INVENTORY_MANAGER', 'BLOOD_BANK_STAFF'] },
        { id: u.centreBAdmin, email: 'demo-centre-b-admin@bloodlink.invalid', roles: ['BLOOD_BANK_ADMIN'] },
        { id: u.centreBStaff, email: 'demo-centre-b-staff@bloodlink.invalid', roles: ['BLOOD_BANK_STAFF'] },
        { id: u.sunriseEmergencyStaff, email: 'demo-sunrise-staff@bloodlink.invalid', roles: ['EMERGENCY_STAFF'] },
      ],
      donors: { total: donorIndex, eligibleForActivation: eligibleCount },
      requests: requestNumbers,
      historicalUnitsIssued: centreAONegHistory + centreAAPosHistory + centreBONegHistory,
      bloodGroups: bg,
      components: comp,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
