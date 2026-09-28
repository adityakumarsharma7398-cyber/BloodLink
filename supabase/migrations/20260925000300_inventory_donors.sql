-- =============================================================================
-- 003 · Inventory & donors: storage_locations, donors, donations, inventory_units,
-- donation_components, transactions (ledger), unit status machine, summary views.
-- Source: proposal §3.8–3.12, §3.23, §5, §11.1.
-- Unit status and ledger rows change ONLY through private.create_inventory_unit()
-- and private.transition_unit_status() (§11.1 "Guarantee (D7)").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- storage_locations (§3.8)
-- -----------------------------------------------------------------------------
create table public.storage_locations (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facilities (id) on delete restrict,
  name            text not null,
  type            public.storage_location_type not null,
  temperature_min numeric(4,1),
  temperature_max numeric(4,1),
  capacity        integer check (capacity > 0),
  status          public.storage_location_status not null default 'ACTIVE',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint storage_locations_facility_name_unique unique (facility_id, name),
  constraint storage_locations_id_facility_unique unique (id, facility_id),
  constraint storage_locations_temp_range check (
    temperature_min is null or temperature_max is null or temperature_max >= temperature_min)
);
create trigger storage_locations_updated_at before update on public.storage_locations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- donors (§3.10) — approximate location only (C8); eligibility never set by BloodLink logic
-- -----------------------------------------------------------------------------
create table public.donors (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid unique references public.users (id) on delete set null,
  full_name             text not null,
  blood_group_id        smallint not null references public.blood_groups (id) on delete restrict,
  blood_group_verified  boolean not null default false,
  date_of_birth         date,
  phone                 text,
  email                 text,
  city                  text,
  latitude              double precision check (latitude between -90 and 90),
  longitude             double precision check (longitude between -180 and 180),
  availability_status   public.donor_availability not null default 'AVAILABLE',
  last_donation_date    date,
  total_donations       integer not null default 0 check (total_donations >= 0),
  status                public.donor_status not null default 'ACTIVE',
  consent_to_contact    boolean not null default false,
  preferred_facility_id uuid references public.facilities (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint donors_contact_required check (phone is not null or email is not null or user_id is not null)
);
create index donors_targeting_idx on public.donors (blood_group_id, status, availability_status)
  where consent_to_contact;
create trigger donors_updated_at before update on public.donors
  for each row execute function private.set_updated_at();

-- C8: store donor coordinates rounded to ~1 km (2 decimal places).
create function private.donors_round_location() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.latitude  := round(new.latitude::numeric, 2)::double precision;
  new.longitude := round(new.longitude::numeric, 2)::double precision;
  return new;
end;
$$;
create trigger donors_round_location before insert or update of latitude, longitude on public.donors
  for each row execute function private.donors_round_location();

-- -----------------------------------------------------------------------------
-- donations (§3.11) — a collection event; screening/eligibility entered by blood-centre staff only
-- -----------------------------------------------------------------------------
create table public.donations (
  id                      uuid primary key default gen_random_uuid(),
  donor_id                uuid not null references public.donors (id) on delete restrict,
  facility_id             uuid not null references public.facilities (id) on delete restrict,
  donation_type           public.donation_type not null default 'WHOLE_BLOOD',
  donation_date           timestamptz not null,
  volume_ml               integer check (volume_ml > 0),
  screening_status        public.screening_status not null default 'PENDING',
  eligibility_status      public.eligibility_status not null default 'PENDING',
  deferral_reason         text,
  activation_recipient_id uuid,   -- FK → donor_activation_recipients added in migration 005
  recorded_by             uuid references public.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  constraint donations_deferral_reason check (
    eligibility_status not in ('TEMPORARILY_DEFERRED', 'PERMANENTLY_DEFERRED') or deferral_reason is not null),
  constraint donations_volume_when_eligible check (volume_ml is not null or eligibility_status <> 'ELIGIBLE')
);
create index donations_donor_date_idx on public.donations (donor_id, donation_date desc);
create index donations_facility_date_idx on public.donations (facility_id, donation_date);

-- Maintain donors.total_donations / last_donation_date from donations (risk F9).
create function private.donations_refresh_donor() returns trigger
language plpgsql set search_path = '' as $$
declare v_donor uuid := coalesce(new.donor_id, old.donor_id);
begin
  update public.donors d set
    total_donations = s.total,
    last_donation_date = s.last_date
  from (
    select count(*)::int as total,
           max((dn.donation_date at time zone 'Asia/Kolkata')::date) as last_date
    from public.donations dn
    where dn.donor_id = v_donor and dn.eligibility_status = 'ELIGIBLE' and dn.volume_ml is not null
  ) s
  where d.id = v_donor;
  return null;
end;
$$;
create trigger donations_refresh_donor after insert or update or delete on public.donations
  for each row execute function private.donations_refresh_donor();

-- -----------------------------------------------------------------------------
-- inventory_units (§3.9) — one row per bag
-- -----------------------------------------------------------------------------
create table public.inventory_units (
  id                      uuid primary key default gen_random_uuid(),
  unit_code               text not null unique,
  facility_id             uuid not null references public.facilities (id) on delete restrict,
  donation_id             uuid references public.donations (id) on delete restrict,
  component_id            smallint not null references public.components (id) on delete restrict,
  blood_group_id          smallint not null references public.blood_groups (id) on delete restrict,
  collection_date         timestamptz not null,
  processing_date         timestamptz,
  expiry_date             timestamptz not null,   -- as labelled on the bag; never computed by BloodLink
  volume_ml               integer check (volume_ml > 0),
  status                  public.inventory_unit_status not null default 'QUARANTINED',
  status_changed_at       timestamptz not null default now(),
  storage_location_id     uuid,
  reserved_for_request_id uuid,   -- FK → requests added in migration 004
  received_at             timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint inventory_units_storage_in_facility foreign key (storage_location_id, facility_id)
    references public.storage_locations (id, facility_id) on delete restrict,
  constraint inventory_units_processing_after_collection check (processing_date is null or processing_date >= collection_date),
  constraint inventory_units_expiry_after_collection check (expiry_date > collection_date),
  constraint inventory_units_reservation_status check (
    reserved_for_request_id is null or status in ('RESERVED', 'DISPATCHED'))
);

create index inventory_units_available_fefo_idx
  on public.inventory_units (facility_id, blood_group_id, component_id, expiry_date) where status = 'AVAILABLE';
create index inventory_units_facility_status_idx on public.inventory_units (facility_id, status);
create index inventory_units_expiry_job_idx
  on public.inventory_units (expiry_date) where status in ('AVAILABLE', 'RESERVED', 'QUARANTINED', 'RECEIVED');
create index inventory_units_donation_idx on public.inventory_units (donation_id);
create index inventory_units_reserved_for_request_idx on public.inventory_units (reserved_for_request_id);
create trigger inventory_units_updated_at before update on public.inventory_units
  for each row execute function private.set_updated_at();

-- Transaction-local marker set only by the unit functions below.
create function private.unit_writes_allowed() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('bloodlink.unit_write', true), '') = 'on';
$$;

create function private.inventory_units_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not private.unit_writes_allowed() then
      raise exception 'inventory units are created only through private.create_inventory_unit()'
        using errcode = 'insufficient_privilege';
    end if;
    if not (select holds_inventory from public.facilities where id = new.facility_id) then
      raise exception 'facility % does not hold inventory', new.facility_id using errcode = 'check_violation';
    end if;
    if not (select is_known from public.blood_groups where id = new.blood_group_id) then
      raise exception 'inventory units must have a known blood group' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE: identity fields are immutable
  if new.unit_code is distinct from old.unit_code
     or new.donation_id is distinct from old.donation_id
     or new.component_id is distinct from old.component_id
     or new.blood_group_id is distinct from old.blood_group_id
     or new.collection_date is distinct from old.collection_date then
    raise exception 'unit_code, donation, component, blood group and collection date are immutable'
      using errcode = 'check_violation';
  end if;
  -- status, holding facility and reservation link change only through transition_unit_status()
  if (new.status is distinct from old.status
      or new.facility_id is distinct from old.facility_id
      or new.reserved_for_request_id is distinct from old.reserved_for_request_id)
     and not private.unit_writes_allowed() then
    raise exception 'unit status changes only through private.transition_unit_status()'
      using errcode = 'insufficient_privilege';
  end if;
  if new.facility_id is distinct from old.facility_id
     and not (select holds_inventory from public.facilities where id = new.facility_id) then
    raise exception 'facility % does not hold inventory', new.facility_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger inventory_units_guard before insert or update on public.inventory_units
  for each row execute function private.inventory_units_guard();

-- -----------------------------------------------------------------------------
-- donation_components (§3.12)
-- -----------------------------------------------------------------------------
create table public.donation_components (
  id                uuid primary key default gen_random_uuid(),
  donation_id       uuid not null references public.donations (id) on delete cascade,
  component_id      smallint not null references public.components (id) on delete restrict,
  inventory_unit_id uuid unique references public.inventory_units (id) on delete restrict,
  processing_date   timestamptz,
  processing_status public.processing_status not null default 'PENDING',
  constraint donation_components_unique unique (donation_id, component_id),
  constraint donation_components_processed_has_unit check (processing_status <> 'PROCESSED' or inventory_unit_id is not null)
);

-- -----------------------------------------------------------------------------
-- transactions (§3.23) — append-only ledger, one row per unit lifecycle event
-- -----------------------------------------------------------------------------
create table public.transactions (
  id                      uuid primary key default gen_random_uuid(),
  transaction_type        public.transaction_type not null,
  -- clock_timestamp(): several events for one unit inside one DB transaction stay in order.
  occurred_at             timestamptz not null default clock_timestamp(),
  facility_id             uuid not null references public.facilities (id) on delete restrict,
  counterpart_facility_id uuid references public.facilities (id) on delete restrict,
  inventory_unit_id       uuid not null references public.inventory_units (id) on delete restrict,
  blood_group_id          smallint not null references public.blood_groups (id) on delete restrict,
  component_id            smallint not null references public.components (id) on delete restrict,
  from_status             public.inventory_unit_status,
  to_status               public.inventory_unit_status not null,
  request_allocation_id   uuid,   -- FK added in migration 004
  transfer_id             uuid,   -- FK added in migration 004
  recorded_by             uuid references public.users (id) on delete set null,   -- null = system
  note                    text,
  constraint transactions_status_changes check (from_status is distinct from to_status),
  constraint transactions_creation_events check (
    (from_status is null) = (transaction_type in ('COMPONENT_CREATED', 'INVENTORY_ADDED', 'PROCUREMENT_RECEIVED')))
);
create index transactions_facility_type_time_idx on public.transactions (facility_id, transaction_type, occurred_at);
create index transactions_unit_time_idx on public.transactions (inventory_unit_id, occurred_at);
create index transactions_consumption_idx on public.transactions (facility_id, blood_group_id, component_id, occurred_at)
  where transaction_type = 'INVENTORY_ISSUED';

create function private.transactions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not private.unit_writes_allowed() then
      raise exception 'ledger rows are written only by the unit lifecycle functions'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  raise exception 'transactions is append-only' using errcode = 'insufficient_privilege';
end;
$$;
create trigger transactions_guard before insert or update or delete on public.transactions
  for each row execute function private.transactions_guard();

create function private.append_only_truncate_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end;
$$;
create trigger transactions_no_truncate before truncate on public.transactions
  for each statement execute function private.append_only_truncate_guard();

-- -----------------------------------------------------------------------------
-- Canonical transition table (§11.1): (from, to) → ledger event. NULL = not allowed.
-- -----------------------------------------------------------------------------
create function private.transition_event(p_from public.inventory_unit_status, p_to public.inventory_unit_status)
returns public.transaction_type language sql immutable set search_path = '' as $$
  select case
    when p_from = 'QUARANTINED' and p_to = 'AVAILABLE'   then 'INVENTORY_ACCEPTED'
    when p_from = 'QUARANTINED' and p_to = 'WASTED'      then 'INVENTORY_WASTED'
    when p_from = 'QUARANTINED' and p_to = 'EXPIRED'     then 'INVENTORY_EXPIRED'
    when p_from = 'AVAILABLE'   and p_to = 'RESERVED'    then 'INVENTORY_RESERVED'
    when p_from = 'AVAILABLE'   and p_to = 'ISSUED'      then 'INVENTORY_ISSUED'
    when p_from = 'AVAILABLE'   and p_to = 'QUARANTINED' then 'INVENTORY_QUARANTINED'
    when p_from = 'AVAILABLE'   and p_to = 'WASTED'      then 'INVENTORY_WASTED'
    when p_from = 'AVAILABLE'   and p_to = 'EXPIRED'     then 'INVENTORY_EXPIRED'
    when p_from = 'RESERVED'    and p_to = 'AVAILABLE'   then 'INVENTORY_RELEASED'
    when p_from = 'RESERVED'    and p_to = 'DISPATCHED'  then 'INVENTORY_DISPATCHED'
    when p_from = 'RESERVED'    and p_to = 'IN_TRANSIT'  then 'TRANSFER_DISPATCHED'
    when p_from = 'RESERVED'    and p_to = 'ISSUED'      then 'INVENTORY_ISSUED'
    when p_from = 'RESERVED'    and p_to = 'WASTED'      then 'INVENTORY_WASTED'
    when p_from = 'RESERVED'    and p_to = 'EXPIRED'     then 'INVENTORY_EXPIRED'
    when p_from = 'DISPATCHED'  and p_to = 'ISSUED'      then 'INVENTORY_ISSUED'
    when p_from = 'DISPATCHED'  and p_to = 'RETURNED'    then 'INVENTORY_RETURNED'
    when p_from = 'DISPATCHED'  and p_to = 'WASTED'      then 'INVENTORY_WASTED'
    when p_from = 'IN_TRANSIT'  and p_to = 'RECEIVED'    then 'TRANSFER_RECEIVED'
    when p_from = 'IN_TRANSIT'  and p_to = 'WASTED'      then 'INVENTORY_WASTED'
    when p_from = 'RECEIVED'    and p_to = 'AVAILABLE'   then 'INVENTORY_ACCEPTED'
    when p_from = 'RECEIVED'    and p_to = 'QUARANTINED' then 'INVENTORY_QUARANTINED'
    when p_from = 'RECEIVED'    and p_to = 'WASTED'      then 'INVENTORY_WASTED'
    when p_from = 'RECEIVED'    and p_to = 'EXPIRED'     then 'INVENTORY_EXPIRED'
    when p_from = 'ISSUED'      and p_to = 'RETURNED'    then 'INVENTORY_RETURNED'
    when p_from = 'RETURNED'    and p_to = 'AVAILABLE'   then 'INVENTORY_ACCEPTED'
    when p_from = 'RETURNED'    and p_to = 'QUARANTINED' then 'INVENTORY_QUARANTINED'
    when p_from = 'RETURNED'    and p_to = 'WASTED'      then 'INVENTORY_WASTED'
  end::public.transaction_type;
$$;

-- Create a unit and its creation ledger event (the only way to insert inventory_units).
create function private.create_inventory_unit(
  p_unit_code text, p_facility uuid, p_component smallint, p_blood_group smallint,
  p_collection_date timestamptz, p_expiry_date timestamptz, p_event public.transaction_type,
  p_initial_status public.inventory_unit_status, p_actor uuid,
  p_donation uuid default null, p_processing_date timestamptz default null, p_volume_ml integer default null,
  p_storage_location uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_event = 'COMPONENT_CREATED' then
    if p_donation is null or p_initial_status <> 'QUARANTINED' then
      raise exception 'COMPONENT_CREATED requires a donation and starts QUARANTINED' using errcode = 'check_violation';
    end if;
  elsif p_event in ('PROCUREMENT_RECEIVED', 'INVENTORY_ADDED') then
    if p_initial_status not in ('QUARANTINED', 'AVAILABLE') then
      raise exception '% creates units as QUARANTINED or AVAILABLE only', p_event using errcode = 'check_violation';
    end if;
  else
    raise exception '% is not a unit creation event', p_event using errcode = 'check_violation';
  end if;

  perform set_config('bloodlink.unit_write', 'on', true);
  insert into public.inventory_units (unit_code, facility_id, donation_id, component_id, blood_group_id,
    collection_date, processing_date, expiry_date, volume_ml, status, storage_location_id)
  values (p_unit_code, p_facility, p_donation, p_component, p_blood_group,
    p_collection_date, p_processing_date, p_expiry_date, p_volume_ml, p_initial_status, p_storage_location)
  returning id into v_id;

  insert into public.transactions (transaction_type, facility_id, inventory_unit_id, blood_group_id, component_id,
    from_status, to_status, recorded_by, note)
  values (p_event, p_facility, v_id, p_blood_group, p_component, null, p_initial_status, p_actor, p_note);
  perform set_config('bloodlink.unit_write', '', true);
  return v_id;
end;
$$;

-- The ONLY way to change a unit's status (§11.1). Validates the pair, writes one ledger row.
create function private.transition_unit_status(
  p_unit uuid, p_to public.inventory_unit_status, p_actor uuid default null,
  p_to_facility uuid default null, p_allocation uuid default null, p_transfer uuid default null,
  p_counterpart uuid default null, p_reserved_for_request uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  u           public.inventory_units%rowtype;
  v_event     public.transaction_type;
  v_facility  uuid;
  v_tx        uuid;
begin
  select * into u from public.inventory_units where id = p_unit for update;
  if not found then
    raise exception 'inventory unit % not found', p_unit using errcode = 'no_data_found';
  end if;
  v_event := private.transition_event(u.status, p_to);
  if v_event is null then
    raise exception 'invalid unit transition % -> %', u.status, p_to using errcode = 'check_violation';
  end if;

  v_facility := u.facility_id;
  if v_event = 'TRANSFER_RECEIVED' then
    if p_to_facility is null then
      raise exception 'TRANSFER_RECEIVED requires the destination facility' using errcode = 'check_violation';
    end if;
    v_facility := p_to_facility;
  elsif p_to_facility is not null and p_to_facility <> u.facility_id then
    raise exception 'only TRANSFER_RECEIVED may move a unit to another facility' using errcode = 'check_violation';
  end if;

  perform set_config('bloodlink.unit_write', 'on', true);
  update public.inventory_units set
    status = p_to,
    status_changed_at = now(),
    facility_id = v_facility,
    storage_location_id = case when v_facility <> u.facility_id then null else storage_location_id end,
    received_at = case when v_facility <> u.facility_id then now() else received_at end,
    reserved_for_request_id = case
      when p_to = 'RESERVED' then p_reserved_for_request
      when p_to = 'DISPATCHED' then reserved_for_request_id
      else null end
  where id = p_unit;

  insert into public.transactions (transaction_type, facility_id, counterpart_facility_id, inventory_unit_id,
    blood_group_id, component_id, from_status, to_status, request_allocation_id, transfer_id, recorded_by, note)
  values (v_event, v_facility, p_counterpart, p_unit, u.blood_group_id, u.component_id, u.status, p_to,
    p_allocation, p_transfer, p_actor, p_note)
  returning id into v_tx;
  perform set_config('bloodlink.unit_write', '', true);
  return v_tx;
end;
$$;

-- -----------------------------------------------------------------------------
-- Aggregate views (§5.3, §7.1) — security_invoker so the caller's RLS applies
-- -----------------------------------------------------------------------------
create view public.v_inventory_summary with (security_invoker = true) as
select facility_id, blood_group_id, component_id,
  count(*) filter (where status not in ('ISSUED', 'WASTED', 'EXPIRED', 'DISPATCHED'))   as on_hand,
  count(*) filter (where status = 'AVAILABLE' and expiry_date > now())                  as usable,
  count(*) filter (where status = 'RESERVED')                                           as reserved,
  count(*) filter (where status in ('QUARANTINED', 'RECEIVED'))                         as pending_acceptance,
  count(*) filter (where status = 'AVAILABLE' and expiry_date > now()
                     and expiry_date <= now() + interval '7 days')                      as expiring_7d
from public.inventory_units
group by facility_id, blood_group_id, component_id;

create view public.v_daily_consumption with (security_invoker = true) as
with issued as (
  select facility_id, blood_group_id, component_id,
         (occurred_at at time zone 'Asia/Kolkata')::date as day
  from public.transactions
  where transaction_type = 'INVENTORY_ISSUED'
), series as (
  select facility_id, blood_group_id, component_id, min(day) as first_day
  from issued group by facility_id, blood_group_id, component_id
), days as (
  select s.facility_id, s.blood_group_id, s.component_id, d::date as day
  from series s,
       generate_series(s.first_day, (now() at time zone 'Asia/Kolkata')::date, interval '1 day') d
)
select d.facility_id, d.blood_group_id, d.component_id, d.day, count(i.day)::integer as units_issued
from days d
left join issued i
  on i.facility_id = d.facility_id and i.blood_group_id = d.blood_group_id
 and i.component_id = d.component_id and i.day = d.day
group by d.facility_id, d.blood_group_id, d.component_id, d.day;
