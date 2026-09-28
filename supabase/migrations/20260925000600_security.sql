-- =============================================================================
-- 006 · Security: audit_logs, RLS helpers, RLS policies (SELECT only), grants,
-- directory views, Realtime publication. Source: proposal §3.24, §9, §10, §11.2.
--
-- Principles (§10.1):
--  * RLS on every public table, default deny.
--  * Browsers are READ-ONLY: no INSERT/UPDATE/DELETE policy and no write grant for anon or
--    authenticated on any table. All writes go through Express (+ private functions).
--  * Express/Prisma connects with a privileged role that bypasses RLS, so backend
--    authorization is mandatory; RLS is defence in depth for direct reads and Realtime.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_logs (§3.24) — append-only; no FKs so history survives
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id              uuid primary key default gen_random_uuid(),
  occurred_at     timestamptz not null default now(),
  user_id         uuid,
  organization_id uuid,
  facility_id     uuid,
  action          text not null,
  entity_type     text not null,
  entity_id       uuid,
  old_value       jsonb,
  new_value       jsonb,
  ip_address      inet,
  correlation_id  uuid
);
create index audit_logs_org_time_idx on public.audit_logs (organization_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_user_time_idx on public.audit_logs (user_id, occurred_at desc);

create function private.audit_logs_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function private.audit_logs_append_only();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.append_only_truncate_guard();

-- -----------------------------------------------------------------------------
-- RLS helpers (§10.1). SECURITY DEFINER, STABLE, fixed search_path. Grants count only
-- for ACTIVE users in VERIFIED/ACTIVE organizations.
-- -----------------------------------------------------------------------------
create function private.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles g
    join public.roles r on r.id = g.role_id and r.code = 'SUPER_ADMIN'
    join public.users u on u.id = g.user_id and u.status = 'ACTIVE'
    where g.user_id = auth.uid());
$$;

create function private.org_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(u.organization_id), '{}')
  from public.users u
  join public.organizations o on o.id = u.organization_id and o.status in ('VERIFIED', 'ACTIVE')
  where u.id = auth.uid() and u.status = 'ACTIVE';
$$;

create function private.admin_org_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(g.organization_id), '{}')
  from public.user_roles g
  join public.roles r on r.id = g.role_id and r.code = 'ORG_ADMIN'
  join public.users u on u.id = g.user_id and u.status = 'ACTIVE'
  join public.organizations o on o.id = g.organization_id and o.status in ('VERIFIED', 'ACTIVE')
  where g.user_id = auth.uid();
$$;

-- Facilities where the caller holds any grant (ORG_ADMIN ⇒ every facility of the organization).
create function private.facility_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct f.id), '{}')
  from public.user_roles g
  join public.roles r on r.id = g.role_id
  join public.users u on u.id = g.user_id and u.status = 'ACTIVE'
  join public.organizations o on o.id = g.organization_id and o.status in ('VERIFIED', 'ACTIVE')
  join public.facilities f on f.organization_id = g.organization_id
   and (f.id = g.facility_id or (g.facility_id is null and r.code = 'ORG_ADMIN'))
  where g.user_id = auth.uid();
$$;

-- Requests with an allocation at one of the caller's facilities (source staff serving a request).
-- SECURITY DEFINER so the requests policy does not recurse through request_items' policy.
create function private.served_request_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct i.request_id), '{}')
  from public.request_allocations a
  join public.request_items i on i.id = a.request_item_id
  where a.source_facility_id = any (private.facility_ids());
$$;

create function private.donor_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.donors where user_id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere
-- -----------------------------------------------------------------------------
alter table public.organizations               enable row level security;
alter table public.facilities                  enable row level security;
alter table public.users                       enable row level security;
alter table public.roles                       enable row level security;
alter table public.user_roles                  enable row level security;
alter table public.blood_groups                enable row level security;
alter table public.components                  enable row level security;
alter table public.storage_locations           enable row level security;
alter table public.inventory_units             enable row level security;
alter table public.donors                      enable row level security;
alter table public.donations                   enable row level security;
alter table public.donation_components         enable row level security;
alter table public.requests                    enable row level security;
alter table public.request_items               enable row level security;
alter table public.request_allocations         enable row level security;
alter table public.transfers                   enable row level security;
alter table public.transfer_items              enable row level security;
alter table public.predictions                 enable row level security;
alter table public.alerts                      enable row level security;
alter table public.donor_activations           enable row level security;
alter table public.donor_activation_recipients enable row level security;
alter table public.recommendations             enable row level security;
alter table public.transactions                enable row level security;
alter table public.audit_logs                  enable row level security;
alter table public.compatibility_rules         enable row level security;
alter table public.planning_parameters         enable row level security;

-- -----------------------------------------------------------------------------
-- SELECT policies (§10.2). There are deliberately NO insert/update/delete policies.
-- (select private.fn()) lets Postgres evaluate each helper once per statement.
-- -----------------------------------------------------------------------------
create policy organizations_select on public.organizations for select to authenticated
  using (id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));

create policy facilities_select on public.facilities for select to authenticated
  using (organization_id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));

create policy users_select on public.users for select to authenticated
  using (id = (select auth.uid())
         or organization_id = any ((select private.admin_org_ids())::uuid[])
         or (select private.is_super_admin()));

create policy roles_select on public.roles for select to authenticated using (true);

create policy user_roles_select on public.user_roles for select to authenticated
  using (user_id = (select auth.uid())
         or organization_id = any ((select private.admin_org_ids())::uuid[])
         or (select private.is_super_admin()));

create policy blood_groups_select on public.blood_groups for select to anon, authenticated using (true);
create policy components_select on public.components for select to anon, authenticated using (true);
create policy compatibility_rules_select on public.compatibility_rules for select to authenticated using (true);

create policy storage_locations_select on public.storage_locations for select to authenticated
  using (facility_id = any ((select private.facility_ids())::uuid[]) or (select private.is_super_admin()));

-- Unit-level inventory: holding facility only — no cross-organization row access (U1).
create policy inventory_units_select on public.inventory_units for select to authenticated
  using (facility_id = any ((select private.facility_ids())::uuid[]) or (select private.is_super_admin()));

create policy donors_select on public.donors for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.is_super_admin())
    or exists (select 1 from public.donor_activation_recipients rc
               join public.donor_activations da on da.id = rc.activation_id
               where rc.donor_id = donors.id and rc.response = 'WILLING'
                 and da.facility_id = any ((select private.facility_ids())::uuid[]))
    or exists (select 1 from public.donations dn
               where dn.donor_id = donors.id and dn.facility_id = any ((select private.facility_ids())::uuid[])));

create policy donations_select on public.donations for select to authenticated
  using (donor_id = (select private.donor_id())
         or facility_id = any ((select private.facility_ids())::uuid[])
         or (select private.is_super_admin()));

create policy donation_components_select on public.donation_components for select to authenticated
  using (exists (select 1 from public.donations dn where dn.id = donation_components.donation_id));

create policy requests_select on public.requests for select to authenticated
  using (
    requester_user_id = (select auth.uid())
    or requester_facility_id = any ((select private.facility_ids())::uuid[])
    or patient_facility_id = any ((select private.facility_ids())::uuid[])
    or verifying_facility_id = any ((select private.facility_ids())::uuid[])
    or (select private.is_super_admin()));
-- A serving/source organization does NOT read request rows (patient_reference, contact_phone,
-- notes, requester). It gets minimum delivery data through public.v_served_requests (B(ii)).

create policy request_items_select on public.request_items for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_items.request_id));

-- Rows hold unit IDs: source facility only (U1, §9.4).
create policy request_allocations_select on public.request_allocations for select to authenticated
  using (source_facility_id = any ((select private.facility_ids())::uuid[]) or (select private.is_super_admin()));

create policy transfers_select on public.transfers for select to authenticated
  using (source_facility_id = any ((select private.facility_ids())::uuid[])
         or destination_facility_id = any ((select private.facility_ids())::uuid[])
         or (select private.is_super_admin()));

create policy transfer_items_select on public.transfer_items for select to authenticated
  using (
    (select private.is_super_admin())
    or exists (select 1 from public.transfers t where t.id = transfer_items.transfer_id and (
      t.source_facility_id = any ((select private.facility_ids())::uuid[])
      or (t.status = 'RECEIVED' and t.destination_facility_id = any ((select private.facility_ids())::uuid[])))));

create policy predictions_select on public.predictions for select to authenticated
  using (organization_id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));
create policy alerts_select on public.alerts for select to authenticated
  using (organization_id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));
create policy recommendations_select on public.recommendations for select to authenticated
  using (organization_id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));
create policy donor_activations_select on public.donor_activations for select to authenticated
  using (organization_id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));

create policy donor_activation_recipients_select on public.donor_activation_recipients for select to authenticated
  using (
    donor_id = (select private.donor_id())
    or (select private.is_super_admin())
    or (response = 'WILLING' and exists (
      select 1 from public.donor_activations da
      where da.id = donor_activation_recipients.activation_id and da.organization_id = any ((select private.org_ids())::uuid[]))));

-- Ledger: only the facility where the event happened.
create policy transactions_select on public.transactions for select to authenticated
  using (facility_id = any ((select private.facility_ids())::uuid[]) or (select private.is_super_admin()));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (organization_id = any ((select private.admin_org_ids())::uuid[]) or (select private.is_super_admin()));

create policy planning_parameters_select on public.planning_parameters for select to authenticated
  using (organization_id is null or organization_id = any ((select private.org_ids())::uuid[]) or (select private.is_super_admin()));

-- -----------------------------------------------------------------------------
-- Directory views (§10.2): basic identity of ACTIVE/VERIFIED organizations and their
-- OPERATIONAL facilities for every signed-in user (e.g. a public requester choosing the
-- treating hospital). Owner-privileged on purpose; exposes no operational data.
-- -----------------------------------------------------------------------------
create view public.v_organization_directory as
  select o.id, o.name, o.type
  from public.organizations o
  where o.status in ('VERIFIED', 'ACTIVE');

create view public.v_facility_directory as
  select f.id, f.organization_id, f.name, f.facility_type, f.address, f.city, f.district, f.state, f.pincode,
         f.latitude, f.longitude, f.phone
  from public.facilities f
  join public.organizations o on o.id = f.organization_id
  where o.status in ('VERIFIED', 'ACTIVE') and f.operating_status = 'OPERATIONAL';

-- -----------------------------------------------------------------------------
-- Minimum delivery data for a serving/source organization (B(ii), 2026-09-25).
-- One row per request item that has an allocation at one of the caller's facilities.
-- Owner-privileged + security_barrier on purpose: exposes ONLY these columns — never
-- patient_reference, contact_phone, notes or requester identity.
-- -----------------------------------------------------------------------------
create view public.v_served_requests with (security_barrier = true) as
  select r.id                                      as request_id,
         r.request_number,
         i.id                                      as request_item_id,
         i.blood_group_id,
         i.component_id,
         i.quantity_requested,
         i.quantity_fulfilled,
         coalesce(i.urgency, r.urgency)            as urgency,
         coalesce(i.required_by, r.required_by)    as required_by,
         r.patient_facility_id                     as destination_facility_id,
         r.status                                  as request_status,
         r.verification_status
  from public.requests r
  join public.request_items i on i.request_id = r.id
  where r.id = any (private.served_request_ids());

-- -----------------------------------------------------------------------------
-- Grants: browsers read-only; private functions backend-only (§6.5, §10)
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant select on public.blood_groups, public.components to anon;

-- Stop future tables/sequences in public from being auto-granted write access to browser roles.
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- private: only RLS helpers are callable by browser roles (needed to evaluate policies);
-- every workflow function is executable by the backend role only.
revoke all on all functions in schema private from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
grant usage on schema private to authenticated;
grant execute on function private.is_super_admin(), private.org_ids(), private.admin_org_ids(),
  private.facility_ids(), private.served_request_ids(), private.donor_id() to authenticated;

-- -----------------------------------------------------------------------------
-- Realtime (§10.4): Postgres Changes applies the SELECT policies above.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;
alter publication supabase_realtime add table
  public.inventory_units, public.requests, public.request_allocations, public.transfers,
  public.predictions, public.recommendations, public.alerts, public.donor_activation_recipients;
