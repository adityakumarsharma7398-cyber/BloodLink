-- =============================================================================
-- 001 · Foundation: schemas, enums, shared trigger function, reference tables.
-- Source: docs/03a_Database_Schema_Proposal.md (revision 4) §2, §3.4, §3.6, §3.7, §3.25.
-- No clinical values are inserted here (U2, U5). Compatibility rules are NOT seeded
-- by migrations; DEMO_ONLY development rows live in supabase/seed/.
-- =============================================================================

-- Non-exposed schema for backend-only and RLS-helper functions. The Supabase Data API
-- exposes only `public`; `private` is never added to the exposed schemas.
create schema if not exists private;
revoke all on schema private from public;

-- -----------------------------------------------------------------------------
-- Enums (§2)
-- -----------------------------------------------------------------------------
create type public.organization_type as enum (
  'HOSPITAL', 'BLOOD_CENTRE', 'HOSPITAL_BLOOD_CENTRE', 'CLINIC', 'NURSING_HOME', 'OTHER_AUTHORIZED_PROVIDER');
create type public.organization_status as enum ('PENDING', 'VERIFIED', 'ACTIVE', 'SUSPENDED');
create type public.facility_type as enum (
  'HOSPITAL', 'BLOOD_CENTRE', 'CLINIC', 'NURSING_HOME', 'EMERGENCY_SERVICE', 'OTHER');
create type public.facility_operating_status as enum ('OPERATIONAL', 'TEMPORARILY_CLOSED', 'INACTIVE');
create type public.user_status as enum ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');
create type public.app_role as enum (
  'SUPER_ADMIN', 'ORG_ADMIN', 'HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF',
  'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER', 'DONOR', 'PUBLIC_REQUESTER');
create type public.role_scope as enum ('PLATFORM', 'ORGANIZATION', 'FACILITY', 'SELF');
create type public.component_category as enum ('WHOLE_BLOOD', 'RED_CELLS', 'PLASMA', 'PLATELETS', 'CRYOPRECIPITATE');
create type public.storage_location_type as enum ('REFRIGERATOR', 'FREEZER', 'PLATELET_INCUBATOR', 'QUARANTINE_AREA', 'OTHER');
create type public.storage_location_status as enum ('ACTIVE', 'MAINTENANCE', 'OUT_OF_SERVICE');
create type public.inventory_unit_status as enum (
  'AVAILABLE', 'RESERVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'ISSUED', 'RETURNED', 'WASTED', 'EXPIRED', 'QUARANTINED');
create type public.donor_availability as enum ('AVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'UNAVAILABLE');
create type public.donor_status as enum ('ACTIVE', 'DEFERRED', 'INACTIVE');
create type public.donation_type as enum ('WHOLE_BLOOD', 'APHERESIS_PLATELETS', 'APHERESIS_PLASMA');
create type public.screening_status as enum ('PENDING', 'PASSED', 'FAILED');
create type public.eligibility_status as enum ('PENDING', 'ELIGIBLE', 'TEMPORARILY_DEFERRED', 'PERMANENTLY_DEFERRED');
create type public.processing_status as enum ('PENDING', 'PROCESSED', 'DISCARDED');
create type public.request_type as enum ('EMERGENCY', 'ROUTINE', 'BULK');
create type public.urgency_level as enum ('CRITICAL', 'HIGH', 'NORMAL');
create type public.verification_status as enum ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED');
create type public.verification_method as enum ('STAFF_AT_CREATION', 'STAFF_REVIEW');
create type public.request_status as enum (
  'OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'REJECTED', 'EXPIRED');
create type public.allocation_status as enum (
  'RESERVED', 'CONFIRMED', 'DISPATCHED', 'ISSUED', 'CANCELLED', 'EXPIRED', 'RETURNED');
create type public.transfer_status as enum ('PROPOSED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'REJECTED', 'CANCELLED');
create type public.prediction_type as enum ('DEMAND', 'SHORTAGE', 'EXPIRY');
create type public.risk_level as enum ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
create type public.alert_type as enum ('SHORTAGE', 'EXPIRY', 'EMERGENCY', 'DONOR', 'TRANSFER');
create type public.alert_status as enum ('UNREAD', 'ACKNOWLEDGED', 'RESOLVED');
create type public.donor_activation_status as enum ('ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED');
create type public.notification_status as enum ('PENDING', 'SENT', 'DELIVERED', 'FAILED');
create type public.donor_response as enum ('NO_RESPONSE', 'WILLING', 'DECLINED');
create type public.recommendation_type as enum ('REDISTRIBUTION', 'PROCUREMENT', 'EMERGENCY_SOURCE', 'DONOR_ACTIVATION');
create type public.recommendation_status as enum ('PENDING', 'APPROVED', 'MODIFIED', 'REJECTED', 'EXPIRED', 'EXECUTED');
create type public.recommendation_source as enum ('AI_SERVICE', 'SYSTEM_RULE');
-- Unit lifecycle events only (D6: no REQUEST_FULFILLED; U3: no DONATION_RECEIVED; D7: three added).
create type public.transaction_type as enum (
  'COMPONENT_CREATED', 'INVENTORY_ADDED', 'PROCUREMENT_RECEIVED',
  'INVENTORY_QUARANTINED', 'INVENTORY_ACCEPTED',
  'INVENTORY_RESERVED', 'INVENTORY_RELEASED', 'INVENTORY_DISPATCHED',
  'INVENTORY_ISSUED', 'INVENTORY_RETURNED',
  'TRANSFER_DISPATCHED', 'TRANSFER_RECEIVED',
  'INVENTORY_WASTED', 'INVENTORY_EXPIRED');
create type public.rule_validation_status as enum ('DEMO_ONLY', 'VALIDATED', 'RETIRED');

-- -----------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- -----------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- blood_groups (§3.6) — reference codes only; UNKNOWN for incomplete emergency information
-- -----------------------------------------------------------------------------
create table public.blood_groups (
  id           smallint generated always as identity primary key,
  code         text     not null unique,
  display_name text     not null,
  abo          text     check (abo in ('A', 'B', 'AB', 'O')),
  rhd          text     check (rhd in ('+', '-')),
  is_known     boolean  not null,
  sort_order   smallint not null,
  constraint blood_groups_known_consistency check (
    (is_known and abo is not null and rhd is not null) or (not is_known and abo is null and rhd is null))
);

insert into public.blood_groups (code, display_name, abo, rhd, is_known, sort_order) values
  ('O-',  'O−',  'O',  '-', true, 1),
  ('O+',  'O+',  'O',  '+', true, 2),
  ('A-',  'A−',  'A',  '-', true, 3),
  ('A+',  'A+',  'A',  '+', true, 4),
  ('B-',  'B−',  'B',  '-', true, 5),
  ('B+',  'B+',  'B',  '+', true, 6),
  ('AB-', 'AB−', 'AB', '-', true, 7),
  ('AB+', 'AB+', 'AB', '+', true, 8),
  ('UNKNOWN', 'Unknown', null, null, false, 9);

-- -----------------------------------------------------------------------------
-- components (§3.7) — clinical values nullable until validated (U5); none seeded
-- -----------------------------------------------------------------------------
create table public.components (
  id                       smallint generated always as identity primary key,
  code                     text                    not null unique,
  name                     text                    not null,
  category                 public.component_category not null,
  storage_temp_min         numeric(4,1),
  storage_temp_max         numeric(4,1),
  typical_storage_days     smallint check (typical_storage_days > 0),
  values_validation_status public.rule_validation_status not null default 'DEMO_ONLY',
  values_source_reference  text,
  values_validated_by      uuid,          -- FK → users added in migration 002
  values_validated_at      timestamptz,
  active                   boolean not null default true,
  constraint components_temp_range check (
    storage_temp_min is null or storage_temp_max is null or storage_temp_max >= storage_temp_min),
  constraint components_validated_values check (
    values_validation_status <> 'VALIDATED' or (
      values_source_reference is not null and values_validated_by is not null
      and values_validated_at is not null and typical_storage_days is not null))
);

insert into public.components (code, name, category) values
  ('WHOLE_BLOOD', 'Whole blood', 'WHOLE_BLOOD'),
  ('PRBC', 'Packed red blood cells', 'RED_CELLS'),
  ('PLASMA_FFP', 'Fresh frozen plasma', 'PLASMA'),
  ('PLATELETS', 'Platelets', 'PLATELETS');

-- -----------------------------------------------------------------------------
-- roles (§3.4) — independent permission sets, no hierarchy (decision D)
-- -----------------------------------------------------------------------------
create table public.roles (
  id          smallint generated always as identity primary key,
  code        public.app_role   not null unique,
  name        text              not null,
  description text,
  scope       public.role_scope not null
);

insert into public.roles (code, name, scope, description) values
  ('SUPER_ADMIN',       'Super admin',        'PLATFORM',     'Platform administration'),
  ('ORG_ADMIN',         'Organization admin', 'ORGANIZATION', 'Administers one organization'),
  ('HOSPITAL_STAFF',    'Hospital staff',     'FACILITY',     'Creates and verifies requests at a hospital'),
  ('DOCTOR',            'Doctor',             'FACILITY',     'Creates and verifies requests'),
  ('EMERGENCY_STAFF',   'Emergency staff',    'FACILITY',     'Creates emergency requests'),
  ('BLOOD_BANK_ADMIN',  'Blood bank admin',   'FACILITY',     'Approves transfers and blood-centre recommendations'),
  ('BLOOD_BANK_STAFF',  'Blood bank staff',   'FACILITY',     'Operates a blood centre'),
  ('INVENTORY_MANAGER', 'Inventory manager',  'FACILITY',     'Manages inventory units'),
  ('DONOR',             'Donor',              'SELF',         'Own donor profile'),
  ('PUBLIC_REQUESTER',  'Public requester',   'SELF',         'Own emergency requests');

-- -----------------------------------------------------------------------------
-- compatibility_rules (§3.25) — configurable reference data; AI never writes these
-- -----------------------------------------------------------------------------
create table public.compatibility_rules (
  id                       smallint generated always as identity primary key,
  donor_blood_group_id     smallint not null references public.blood_groups (id) on delete restrict,
  recipient_blood_group_id smallint not null references public.blood_groups (id) on delete restrict,
  component_id             smallint not null references public.components (id) on delete restrict,
  compatible               boolean  not null,
  priority                 smallint not null check (priority > 0),
  validation_status        public.rule_validation_status not null default 'DEMO_ONLY',
  source_reference         text,
  source_url               text,
  validated_by             uuid,          -- FK → users added in migration 002
  validated_at             timestamptz,
  validation_note          text,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint compatibility_rules_validated check (
    validation_status <> 'VALIDATED' or (
      source_reference is not null and validated_by is not null and validated_at is not null))
);

create unique index compatibility_rules_active_unique
  on public.compatibility_rules (donor_blood_group_id, recipient_blood_group_id, component_id)
  where validation_status <> 'RETIRED';

create function private.compatibility_rules_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not (select is_known from public.blood_groups where id = new.donor_blood_group_id) then
    raise exception 'compatibility rule donor blood group must be a known group'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger compatibility_rules_check
  before insert or update on public.compatibility_rules
  for each row execute function private.compatibility_rules_check();
create trigger compatibility_rules_updated_at
  before update on public.compatibility_rules
  for each row execute function private.set_updated_at();
