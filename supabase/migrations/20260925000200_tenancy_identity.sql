-- =============================================================================
-- 002 · Tenancy & identity: organizations, facilities, users, user_roles, planning_parameters.
-- Source: proposal §3.1–3.5, §3.26, §9. auth.users (Supabase Auth) is the identity;
-- public.users is a profile with NO password column (decision C).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- organizations (§3.1)
-- -----------------------------------------------------------------------------
create table public.organizations (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null check (char_length(name) between 2 and 200),
  type                        public.organization_type not null,
  registration_number         text,
  licence_number              text,
  phone                       text,
  email                       text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  website                     text,
  status                      public.organization_status not null default 'PENDING',
  shares_network_availability boolean not null default false,
  verified_at                 timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint organizations_licence_required check (
    licence_number is not null
    or type not in ('BLOOD_CENTRE', 'HOSPITAL_BLOOD_CENTRE')
    or status in ('PENDING', 'SUSPENDED')),
  constraint organizations_verified_at check (status not in ('VERIFIED', 'ACTIVE') or verified_at is not null)
);

create unique index organizations_registration_number_unique
  on public.organizations (registration_number) where registration_number is not null;
create index organizations_type_status_idx on public.organizations (type, status);
create trigger organizations_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- facilities (§3.2)
-- -----------------------------------------------------------------------------
create table public.facilities (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete restrict,
  name                    text not null,
  facility_type           public.facility_type not null,
  holds_inventory         boolean not null default false,
  accepts_temporary_holds boolean not null default false,
  address                 text not null,
  city                    text not null,
  district                text,
  state                   text not null,
  pincode                 text check (pincode is null or pincode ~ '^[1-9][0-9]{5}$'),
  latitude                double precision not null check (latitude between -90 and 90),
  longitude               double precision not null check (longitude between -180 and 180),
  phone                   text,
  operating_status        public.facility_operating_status not null default 'OPERATIONAL',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint facilities_org_name_unique unique (organization_id, name),
  constraint facilities_id_org_unique unique (id, organization_id)
);

create index facilities_organization_idx on public.facilities (organization_id);
create index facilities_type_status_idx on public.facilities (facility_type, operating_status);
create trigger facilities_updated_at before update on public.facilities
  for each row execute function private.set_updated_at();

-- Facility type must fit the organization type (§3.2).
create function private.facility_type_allowed(org_type public.organization_type, f_type public.facility_type)
returns boolean language sql immutable set search_path = '' as $$
  select case org_type
    when 'HOSPITAL' then f_type = 'HOSPITAL'
    when 'BLOOD_CENTRE' then f_type = 'BLOOD_CENTRE'
    when 'HOSPITAL_BLOOD_CENTRE' then f_type in ('HOSPITAL', 'BLOOD_CENTRE')
    when 'CLINIC' then f_type in ('CLINIC', 'EMERGENCY_SERVICE')
    when 'NURSING_HOME' then f_type in ('NURSING_HOME', 'EMERGENCY_SERVICE')
    when 'OTHER_AUTHORIZED_PROVIDER' then f_type in ('OTHER', 'EMERGENCY_SERVICE')
  end;
$$;

create function private.facilities_type_check() returns trigger
language plpgsql set search_path = '' as $$
declare org_type public.organization_type;
begin
  select type into org_type from public.organizations where id = new.organization_id;
  if not private.facility_type_allowed(org_type, new.facility_type) then
    raise exception 'facility type % is not allowed for organization type %', new.facility_type, org_type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger facilities_type_check before insert or update of facility_type, organization_id
  on public.facilities for each row execute function private.facilities_type_check();

create function private.organizations_type_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.facilities f
             where f.organization_id = new.id and not private.facility_type_allowed(new.type, f.facility_type)) then
    raise exception 'organization type % conflicts with its existing facilities', new.type
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger organizations_type_check before update of type on public.organizations
  for each row execute function private.organizations_type_check();

-- -----------------------------------------------------------------------------
-- users (§3.3) — profile for auth.users; never hard-deleted (C11)
-- -----------------------------------------------------------------------------
create table public.users (
  id              uuid primary key references auth.users (id) on delete restrict,
  organization_id uuid references public.organizations (id) on delete restrict,
  facility_id     uuid,
  full_name       text not null,
  email           text not null,
  phone           text,
  status          public.user_status not null default 'INVITED',
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint users_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict,
  constraint users_facility_requires_org check (facility_id is null or organization_id is not null)
);

create unique index users_email_unique on public.users (lower(email));
create index users_organization_idx on public.users (organization_id);
create trigger users_updated_at before update on public.users
  for each row execute function private.set_updated_at();

-- Deferred FKs from migration 001 (approver accounts)
alter table public.components add constraint components_values_validated_by_fkey
  foreign key (values_validated_by) references public.users (id) on delete set null;
alter table public.compatibility_rules add constraint compatibility_rules_validated_by_fkey
  foreign key (validated_by) references public.users (id) on delete set null;

-- -----------------------------------------------------------------------------
-- user_roles (§3.5)
-- -----------------------------------------------------------------------------
create table public.user_roles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  role_id         smallint not null references public.roles (id) on delete restrict,
  organization_id uuid references public.organizations (id) on delete restrict,
  facility_id     uuid,
  granted_by      uuid references public.users (id) on delete set null,
  granted_at      timestamptz not null default now(),
  constraint user_roles_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict,
  constraint user_roles_unique unique nulls not distinct (user_id, role_id, organization_id, facility_id)
);

create index user_roles_user_idx on public.user_roles (user_id);
create index user_roles_facility_role_idx on public.user_roles (facility_id, role_id);

-- Scope rules (§9.2): which organization/facility link each role requires.
create function private.user_roles_scope_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  r_code  public.app_role;
  r_scope public.role_scope;
  u_org   uuid;
  f_type  public.facility_type;
  f_inv   boolean;
  v_allowed boolean;
begin
  select code, scope into r_code, r_scope from public.roles where id = new.role_id;
  select organization_id into u_org from public.users where id = new.user_id;

  if r_scope in ('PLATFORM', 'SELF') then
    if new.organization_id is not null or new.facility_id is not null then
      raise exception 'role % must not be scoped to an organization or facility', r_code using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.organization_id is null or new.organization_id is distinct from u_org then
    raise exception 'role % must be granted within the user''s own organization', r_code using errcode = 'check_violation';
  end if;

  if r_scope = 'ORGANIZATION' then
    if new.facility_id is not null then
      raise exception 'role % is organization-wide and takes no facility', r_code using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- FACILITY scope
  if new.facility_id is null then
    raise exception 'role % requires a facility', r_code using errcode = 'check_violation';
  end if;
  select facility_type, holds_inventory into f_type, f_inv from public.facilities where id = new.facility_id;
  v_allowed := case r_code
      when 'HOSPITAL_STAFF'    then f_type in ('HOSPITAL', 'NURSING_HOME')
      when 'DOCTOR'            then f_type in ('HOSPITAL', 'CLINIC', 'NURSING_HOME')
      when 'EMERGENCY_STAFF'   then f_type in ('HOSPITAL', 'CLINIC', 'EMERGENCY_SERVICE')
      when 'BLOOD_BANK_ADMIN'  then f_type = 'BLOOD_CENTRE'
      when 'BLOOD_BANK_STAFF'  then f_type = 'BLOOD_CENTRE'
      when 'INVENTORY_MANAGER' then f_inv
      else false
    end;
  if not coalesce(v_allowed, false) then
    raise exception 'role % cannot be granted at a % facility', r_code, f_type using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger user_roles_scope_check before insert or update on public.user_roles
  for each row execute function private.user_roles_scope_check();

-- -----------------------------------------------------------------------------
-- Role helper used by backend-only functions (and by RLS helpers in migration 006).
-- Grants count only for ACTIVE users in VERIFIED/ACTIVE organizations (§10.1).
-- ORG_ADMIN counts at every facility of its organization when included in `roles`.
-- -----------------------------------------------------------------------------
create function private.user_has_role_at(p_user uuid, p_facility uuid, p_roles public.app_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.user_roles g
    join public.roles r          on r.id = g.role_id
    join public.users u          on u.id = g.user_id and u.status = 'ACTIVE'
    join public.organizations o  on o.id = g.organization_id and o.status in ('VERIFIED', 'ACTIVE')
    join public.facilities f     on f.id = p_facility and f.organization_id = g.organization_id
    where g.user_id = p_user
      and r.code = any (p_roles)
      and (g.facility_id = p_facility or (g.facility_id is null and r.code = 'ORG_ADMIN'))
  );
$$;

-- -----------------------------------------------------------------------------
-- planning_parameters (§3.26) — schema only; NO rows until values are approved (U4, U8)
-- -----------------------------------------------------------------------------
create table public.planning_parameters (
  id              uuid primary key default gen_random_uuid(),
  key             text not null,
  organization_id uuid references public.organizations (id) on delete restrict,
  facility_id     uuid,
  blood_group_id  smallint references public.blood_groups (id) on delete restrict,
  component_id    smallint references public.components (id) on delete restrict,
  value           jsonb not null check (jsonb_typeof(value) in ('number', 'object')),
  description     text not null,
  updated_by      uuid references public.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  constraint planning_parameters_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict,
  constraint planning_parameters_facility_requires_org check (facility_id is null or organization_id is not null),
  constraint planning_parameters_scope_unique
    unique nulls not distinct (key, organization_id, facility_id, blood_group_id, component_id)
);
create trigger planning_parameters_updated_at before update on public.planning_parameters
  for each row execute function private.set_updated_at();

-- Most specific wins (§3.26): facility > organization > network, then blood group, then component.
-- This ordering contains the documented precedence list exactly. A missing key is an error.
create function private.resolve_parameter(p_key text, p_facility uuid, p_blood_group smallint, p_component smallint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_value jsonb;
begin
  select organization_id into v_org from public.facilities where id = p_facility;
  select pp.value into v_value
  from public.planning_parameters pp
  where pp.key = p_key
    and (pp.facility_id is null or pp.facility_id = p_facility)
    and (pp.organization_id is null or pp.organization_id = v_org)
    and (pp.blood_group_id is null or pp.blood_group_id = p_blood_group)
    and (pp.component_id is null or pp.component_id = p_component)
  order by (pp.facility_id is not null) desc,
           (pp.organization_id is not null) desc,
           (pp.blood_group_id is not null) desc,
           (pp.component_id is not null) desc
  limit 1;
  if v_value is null then
    raise exception 'planning parameter "%" is not configured for facility %', p_key, p_facility
      using errcode = 'no_data_found';
  end if;
  return v_value;
end;
$$;
