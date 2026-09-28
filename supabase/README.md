# Supabase

BloodLink uses a **hosted** Supabase project (PostgreSQL, Auth, Storage, Realtime). No local Docker
is required. The approved design is [`docs/03a_Database_Schema_Proposal.md`](../docs/03a_Database_Schema_Proposal.md)
(revision 4).

## Migrations — the database source of truth

| File | Contents (proposal §18) |
|---|---|
| `20260925000100_foundation.sql` | `private` schema, 36 enums, `set_updated_at`, reference tables (blood_groups, components, roles, compatibility_rules) + reference codes |
| `20260925000200_tenancy_identity.sql` | organizations, facilities, users (→ auth.users), user_roles, planning_parameters; scope/type triggers; role helper; parameter resolver |
| `20260925000300_inventory_donors.sql` | storage_locations, donors, donations, inventory_units, donation_components, transactions; unit state machine; summary views |
| `20260925000400_requests_transfers.sql` | requests, request_items, request_allocations, transfers, transfer_items; source-context hold functions (§6.5); transfer workflow; issued-unit codes (§9.4); expiry job |
| `20260925000500_intelligence.sql` | predictions, recommendations, alerts, donor_activations, donor_activation_recipients; backend-only network aggregate (§10.3) |
| `20260925000600_security.sql` | audit_logs, RLS helpers + SELECT-only policies, grants, directory views, Realtime publication |
| `20260925000700_scheduled_jobs.sql` | pg_cron: release expired holds (every minute), expire units (hourly) |

Prisma (`backend/prisma/schema.prisma`) is generated from the live database with `prisma db pull`;
it never owns migrations. Never run `prisma migrate` or `prisma db push`.

`seed/` holds development/demo data only. `seed/001_demo_compatibility_rules.sql` contains DEMO_ONLY,
**not clinically validated** rows and is applied only at the seed-data stage.

## Connecting and applying

1. Put the project's values in the root `.env` (see `.env.example`), including `DATABASE_URL` and `DIRECT_URL`.
2. Check pg_cron is available (Dashboard → Database → Extensions → `pg_cron`). Migration 007 enables it with
   `create extension if not exists pg_cron`.
3. Apply migrations (Supabase CLI via npx; `db push` talks to the remote database directly, no Docker):

   ```bash
   npx supabase db push --db-url "$DIRECT_URL"
   ```

4. Regenerate the typed client and verify:

   ```bash
   npm --prefix backend run prisma:pull
   ```

   ```bash
   npm --prefix backend run prisma:generate
   ```

   ```bash
   DB_VERIFY_URL="$DIRECT_URL" npm --prefix backend run test:db
   ```

   Against hosted, tests only read the catalog or run inside transactions that are rolled back; the
   two-session concurrency suite is skipped there because it needs committed fixture data.

## Local verification without Supabase

`npm run test:db` (from the repo root) starts a throwaway PostgreSQL 17, applies a minimal stand-in for
Supabase's `auth` schema and roles (`backend/tests/db/supabase-shim.sql`), applies migrations 001–006 and
runs the full database suite, including real two-session concurrency tests. pg_cron is not available
locally, so migration 007 is verified on hosted only.
