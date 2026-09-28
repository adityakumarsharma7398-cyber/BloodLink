/**
 * DEMO_ONLY — additive Supabase Auth setup for END-TO-END BROWSER VERIFICATION.
 *
 * The 7 fixed-UUID demo staff `auth.users` rows created by `seedDemoData.ts` (via a bare
 * `insert into auth.users (id, email) ...`) have no password and no instance_id/aud/role, so they
 * cannot sign in for real. This script does NOT touch those rows in any way. Instead it creates, via
 * the Supabase Admin API only (never raw SQL against `auth.users`), up to 3 NEW real login users —
 * one hospital, one blood-centre, one donor — granted roles at the SAME existing demo
 * organizations/facilities, using the application's own `public.users` / `public.user_roles` tables
 * (ordinary data writes, identical in kind to what `seedDemoData.ts` itself does).
 *
 * Safety:
 *  - Refuses to run unless NODE_ENV !== 'production' and the DATABASE_URL host does not look like a
 *    literal production identifier.
 *  - Requires an explicit --yes flag.
 *  - Idempotent: if a demo verification user with the same email already exists (in public.users),
 *    it is reused rather than duplicated.
 *  - Never prints the service-role key, and never prints the generated password — the password is
 *    written ONLY to a local credentials file (chosen by --out, default alongside this script,
 *    gitignored by name pattern `*.local.json`) for the operator's own use.
 *  - Never mutates existing `auth.users` rows, never deletes demo data, never touches migrations.
 *
 * Usage:
 *   node scripts/demo-auth-verify-setup.mjs --yes [--out <path>]
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import ws from 'ws';
import { loadRuntimeConfig } from '../src/config/env.js';

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  fail('This creates new DEMO_ONLY Supabase Auth users for browser verification. Re-run with --yes to confirm.');
}
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.resolve(import.meta.dirname, 'demo-verify-credentials.local.json');

if (process.env.NODE_ENV === 'production') {
  fail('Refusing to run: NODE_ENV=production.');
}

const config = loadRuntimeConfig();
if (!config.database.url) fail('DATABASE_URL is not configured.');
if (/\bprod(uction)?\b/i.test(config.database.url)) {
  fail('Refusing to run: DATABASE_URL looks like it may point at a production database.');
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.');
}

// Existing DEMO_ONLY fixed IDs (backend/src/demo/ids.ts) — read only, never modified.
const ABC_ORG = '00000000-0000-4000-a000-000000000001';
const ABC_HOSPITAL_FACILITY = '00000000-0000-4000-a000-000000000101';
const CENTRE_A_FACILITY = '00000000-0000-4000-a000-000000000102';
const DONOR_DEMO_ID = '00000000-0000-4000-a000-000000000301'; // demoDonorId(1) = "Demo Donor E1" — O-, near Centre A, eligible

const PERSONAS = [
  { key: 'hospital', email: 'demo-verify-hospital@bloodlink.invalid', fullName: 'Demo Verify Hospital Staff', organizationId: ABC_ORG, facilityId: ABC_HOSPITAL_FACILITY, roles: ['HOSPITAL_STAFF'] },
  { key: 'bloodCentre', email: 'demo-verify-bloodcentre@bloodlink.invalid', fullName: 'Demo Verify Blood Centre Admin', organizationId: ABC_ORG, facilityId: CENTRE_A_FACILITY, roles: ['BLOOD_BANK_ADMIN', 'INVENTORY_MANAGER'] },
  { key: 'donor', email: 'demo-verify-donor@bloodlink.invalid', fullName: 'Demo Verify Donor', organizationId: null, facilityId: null, roles: ['DONOR'] },
];

async function main() {
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
  });
  const client = new pg.Client({ connectionString: config.database.url, ssl: config.database.ssl.mode === 'disable' ? false : { rejectUnauthorized: config.database.ssl.mode === 'verify' } });
  await client.connect();

  const password = randomBytes(18).toString('base64url');
  const results = {};

  try {
    for (const persona of PERSONAS) {
      const existing = await client.query('select id from public.users where email = $1', [persona.email]);
      let userId;
      if (existing.rows.length > 0) {
        userId = existing.rows[0].id;
        // Idempotent re-run: still (re)set the password so the credentials file stays usable.
        const { error } = await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
        if (error) throw new Error(`updateUserById(${persona.email}): ${error.message}`);
        console.log(`Reusing existing demo verification user ${persona.email} -> ${userId}`);
      } else {
        const { data: created, error } = await admin.auth.admin.createUser({ email: persona.email, password, email_confirm: true });
        if (error) throw new Error(`createUser(${persona.email}): ${error.message}`);
        userId = created.user.id;
        await client.query(
          `insert into public.users (id, organization_id, facility_id, full_name, email, status) values ($1, $2, $3, $4, $5, 'ACTIVE')`,
          [userId, persona.organizationId, persona.facilityId, persona.fullName, persona.email],
        );
        for (const role of persona.roles) {
          await client.query(
            `insert into public.user_roles (user_id, role_id, organization_id, facility_id) select $1, id, $2, $3 from public.roles where code = $4::public.app_role`,
            [userId, persona.organizationId, persona.facilityId, role],
          );
        }
        console.log(`Created demo verification user ${persona.email} (${persona.roles.join(', ')}) -> ${userId}`);
      }
      results[persona.key] = { email: persona.email, userId, roles: persona.roles, organizationId: persona.organizationId, facilityId: persona.facilityId };
    }

    // Link the donor persona to an existing eligible demo donor profile, only if not already linked.
    const donorLink = await client.query(
      'update public.donors set user_id = $1 where id = $2 and user_id is null returning id, full_name',
      [results.donor.userId, DONOR_DEMO_ID],
    );
    if (donorLink.rows.length > 0) {
      console.log('Linked donor profile:', donorLink.rows[0]);
      results.donor.linkedDonorProfileId = donorLink.rows[0].id;
    } else {
      const current = await client.query('select id, user_id from public.donors where id = $1', [DONOR_DEMO_ID]);
      console.log('Donor profile link left unchanged (already linked or missing):', current.rows[0]);
      results.donor.linkedDonorProfileId = current.rows[0]?.user_id === results.donor.userId ? DONOR_DEMO_ID : null;
    }

    writeFileSync(outPath, JSON.stringify({ password, users: results }, null, 2), { mode: 0o600 });
    console.log(`\nCredentials (including the password) written ONLY to: ${outPath}`);
    console.log('Emails and role assignments (no password) are printed above.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
