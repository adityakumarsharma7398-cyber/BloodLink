-- =============================================================================
-- 004 · Requests & transfers: requests, request_items, request_allocations, transfers,
-- transfer_items; source-context temporary holds (§6.5), transfer workflow (§6.4),
-- issued-unit code access (§9.4), expiry job.
-- Allocations, transfer status and transfer items change ONLY through the private
-- functions below; direct writes are rejected by trigger.
-- Audit rows are written inside these functions (audit_logs is created in migration 006).
-- =============================================================================

create sequence public.request_number_seq;
create sequence public.transfer_number_seq;

-- -----------------------------------------------------------------------------
-- requests (§3.13)
-- -----------------------------------------------------------------------------
create table public.requests (
  id                    uuid primary key default gen_random_uuid(),
  request_number        text not null unique default (
    'REQ-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-'
    || lpad(nextval('public.request_number_seq')::text, 6, '0')),
  requester_user_id     uuid not null references public.users (id) on delete restrict,
  requester_facility_id uuid references public.facilities (id) on delete restrict,
  patient_facility_id   uuid not null references public.facilities (id) on delete restrict,
  verifying_facility_id uuid not null references public.facilities (id) on delete restrict,
  request_type          public.request_type not null,
  urgency               public.urgency_level not null default 'NORMAL',
  required_by           timestamptz not null,
  patient_reference     text,
  contact_phone         text,
  verification_status   public.verification_status not null default 'PENDING_VERIFICATION',
  verification_method   public.verification_method,
  verified_by           uuid references public.users (id) on delete set null,
  verified_at           timestamptz,
  verification_note     text,
  status                public.request_status not null default 'OPEN',
  notes                 text,
  cancelled_at          timestamptz,
  fulfilled_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- An unverified request can never reach allocation or fulfilment (§6.2).
  constraint requests_verified_before_allocation check (
    status not in ('ALLOCATED', 'PARTIALLY_FULFILLED', 'FULFILLED') or verification_status = 'VERIFIED'),
  constraint requests_verification_evidence check (
    verification_status = 'PENDING_VERIFICATION'
    or (verified_by is not null and verified_at is not null and verification_method is not null)),
  constraint requests_rejection_note check (verification_status <> 'REJECTED' or verification_note is not null),
  constraint requests_rejected_status check (verification_status <> 'REJECTED' or status = 'REJECTED'),
  constraint requests_public_contact check (requester_facility_id is not null or contact_phone is not null)
);
create index requests_verifying_idx on public.requests (verifying_facility_id, verification_status);
create index requests_patient_status_idx on public.requests (patient_facility_id, status);
create index requests_requester_idx on public.requests (requester_user_id, created_at desc);
create index requests_open_deadline_idx on public.requests (status, required_by)
  where status in ('OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED');
create trigger requests_updated_at before update on public.requests
  for each row execute function private.set_updated_at();

-- Creator and verifier rules (decision 2, §6.1–6.2).
create function private.requests_rules() returns trigger
language plpgsql set search_path = '' as $$
declare
  staff_roles constant public.app_role[] := array['HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF']::public.app_role[];
  review_roles constant public.app_role[] := array['HOSPITAL_STAFF', 'DOCTOR']::public.app_role[];
begin
  if tg_op = 'INSERT' then
    new.verifying_facility_id := coalesce(new.verifying_facility_id, new.patient_facility_id);
    if new.requester_facility_id is not null
       and not private.user_has_role_at(new.requester_user_id, new.requester_facility_id, staff_roles) then
      raise exception 'requester has no staff role at the requesting facility' using errcode = 'insufficient_privilege';
    end if;
  else
    if old.verification_status <> 'PENDING_VERIFICATION' and new.verification_status <> old.verification_status then
      raise exception 'verification can be decided only once' using errcode = 'check_violation';
    end if;
    if new.requester_user_id <> old.requester_user_id
       or new.requester_facility_id is distinct from old.requester_facility_id then
      raise exception 'the requester of a request cannot change' using errcode = 'check_violation';
    end if;
  end if;

  if new.verification_status <> 'PENDING_VERIFICATION'
     and (tg_op = 'INSERT' or old.verification_status = 'PENDING_VERIFICATION') then
    if new.verification_method = 'STAFF_AT_CREATION' then
      if tg_op <> 'INSERT' or new.verification_status <> 'VERIFIED'
         or new.verified_by is distinct from new.requester_user_id
         or new.requester_facility_id is null
         or not private.user_has_role_at(new.requester_user_id, new.requester_facility_id, staff_roles) then
        raise exception 'STAFF_AT_CREATION requires an authorized staff creator of a verified organization'
          using errcode = 'insufficient_privilege';
      end if;
    elsif new.verification_method = 'STAFF_REVIEW' then
      if new.verified_by = new.requester_user_id
         or not private.user_has_role_at(new.verified_by, new.verifying_facility_id, review_roles) then
        raise exception 'STAFF_REVIEW requires a different authorized user at the verifying facility'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger requests_rules before insert or update on public.requests
  for each row execute function private.requests_rules();

-- -----------------------------------------------------------------------------
-- request_items (§3.14)
-- -----------------------------------------------------------------------------
create table public.request_items (
  id                           uuid primary key default gen_random_uuid(),
  request_id                   uuid not null references public.requests (id) on delete cascade,
  blood_group_id               smallint not null references public.blood_groups (id) on delete restrict,
  component_id                 smallint not null references public.components (id) on delete restrict,
  quantity_requested           smallint not null check (quantity_requested between 1 and 100),
  quantity_fulfilled           smallint not null default 0,
  urgency                      public.urgency_level,
  required_by                  timestamptz,
  allow_compatible_substitutes boolean not null default true,
  constraint request_items_unique unique (request_id, blood_group_id, component_id),
  constraint request_items_fulfilled_range check (quantity_fulfilled between 0 and quantity_requested)
);
create index request_items_product_idx on public.request_items (blood_group_id, component_id);

alter table public.inventory_units add constraint inventory_units_reserved_for_request_fkey
  foreign key (reserved_for_request_id) references public.requests (id) on delete set null;

-- -----------------------------------------------------------------------------
-- request_allocations (§3.15) — one unit ↔ one request item
-- -----------------------------------------------------------------------------
create table public.request_allocations (
  id                 uuid primary key default gen_random_uuid(),
  request_item_id    uuid not null references public.request_items (id) on delete restrict,
  inventory_unit_id  uuid not null references public.inventory_units (id) on delete restrict,
  source_facility_id uuid not null references public.facilities (id) on delete restrict,
  recommendation_id  uuid,   -- FK → recommendations added in migration 005
  status             public.allocation_status not null default 'RESERVED',
  allocated_at       timestamptz not null default now(),
  allocated_by       uuid not null references public.users (id) on delete restrict,
  hold_expires_at    timestamptz,
  confirmed_by       uuid references public.users (id) on delete restrict,
  confirmed_at       timestamptz,
  dispatched_at      timestamptz,
  issued_at          timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  constraint request_allocations_confirmed_before_release check (
    status in ('RESERVED', 'CANCELLED', 'EXPIRED') or (confirmed_by is not null and confirmed_at is not null)),
  constraint request_allocations_hold_deadline check (status <> 'RESERVED' or hold_expires_at is not null),
  constraint request_allocations_end_reason check (
    status not in ('CANCELLED', 'EXPIRED') or (cancelled_at is not null and cancel_reason is not null))
);
create unique index request_allocations_one_active_per_unit on public.request_allocations (inventory_unit_id)
  where status in ('RESERVED', 'CONFIRMED', 'DISPATCHED');
create index request_allocations_item_idx on public.request_allocations (request_item_id);
create index request_allocations_source_status_idx on public.request_allocations (source_facility_id, status);
create index request_allocations_hold_expiry_idx on public.request_allocations (hold_expires_at) where status = 'RESERVED';

alter table public.transactions add constraint transactions_request_allocation_fkey
  foreign key (request_allocation_id) references public.request_allocations (id) on delete set null;

create function private.allocation_writes_allowed() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('bloodlink.allocation_write', true), '') = 'on';
$$;

-- Returns the best (lowest) priority of an allowed compatibility rule, or null if not compatible.
create function private.compatibility_priority(
  p_donor_group smallint, p_recipient_group smallint, p_component smallint,
  p_allow_substitutes boolean, p_allow_demo_rules boolean)
returns smallint language sql stable set search_path = '' as $$
  select min(r.priority)
  from public.compatibility_rules r
  where r.donor_blood_group_id = p_donor_group
    and r.recipient_blood_group_id = p_recipient_group
    and r.component_id = p_component
    and r.compatible
    and (r.validation_status = 'VALIDATED' or (r.validation_status = 'DEMO_ONLY' and p_allow_demo_rules))
    and (p_allow_substitutes or r.donor_blood_group_id = r.recipient_blood_group_id);
$$;

create function private.request_allocations_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  it public.request_items%rowtype;
  rq public.requests%rowtype;
  un public.inventory_units%rowtype;
begin
  if not private.allocation_writes_allowed() then
    raise exception 'allocations change only through the private hold/allocation functions'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    select * into it from public.request_items where id = new.request_item_id;
    select * into rq from public.requests where id = it.request_id;
    select * into un from public.inventory_units where id = new.inventory_unit_id;
    if rq.verification_status <> 'VERIFIED' then
      raise exception 'allocations require a VERIFIED request' using errcode = 'check_violation';
    end if;
    if un.facility_id <> new.source_facility_id or un.status <> 'AVAILABLE' then
      raise exception 'unit must be AVAILABLE at the source facility' using errcode = 'check_violation';
    end if;
    if un.component_id <> it.component_id or private.compatibility_priority(
         un.blood_group_id, it.blood_group_id, it.component_id, it.allow_compatible_substitutes,
         coalesce(current_setting('bloodlink.allow_demo_rules', true), '') = 'on') is null then
      raise exception 'unit is not compatible under an allowed compatibility rule' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger request_allocations_guard before insert or update or delete on public.request_allocations
  for each row execute function private.request_allocations_guard();

-- -----------------------------------------------------------------------------
-- transfers (§3.16) and transfer_items (§3.17)
-- -----------------------------------------------------------------------------
create table public.transfers (
  id                        uuid primary key default gen_random_uuid(),
  transfer_number           text not null unique default (
    'TRF-' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY') || '-'
    || lpad(nextval('public.transfer_number_seq')::text, 6, '0')),
  source_facility_id        uuid not null references public.facilities (id) on delete restrict,
  destination_facility_id   uuid not null references public.facilities (id) on delete restrict,
  blood_group_id            smallint not null references public.blood_groups (id) on delete restrict,
  component_id              smallint not null references public.components (id) on delete restrict,
  requested_quantity        smallint not null check (requested_quantity > 0),
  approved_quantity         smallint,
  recommendation_id         uuid,   -- FK → recommendations added in migration 005
  status                    public.transfer_status not null default 'PROPOSED',
  reason                    text,
  initiated_by              uuid not null references public.users (id) on delete restrict,
  approved_by               uuid references public.users (id) on delete restrict,
  rejected_by               uuid references public.users (id) on delete restrict,
  rejection_reason          text,
  dispatched_by             uuid references public.users (id) on delete restrict,
  received_by               uuid references public.users (id) on delete restrict,
  requested_at              timestamptz not null default now(),
  approved_at               timestamptz,
  dispatched_at             timestamptz,
  received_at               timestamptz,
  cancelled_at              timestamptz,
  estimated_transit_minutes integer check (estimated_transit_minutes >= 0),
  updated_at                timestamptz not null default now(),
  constraint transfers_distinct_facilities check (destination_facility_id <> source_facility_id),
  constraint transfers_approved_quantity check (
    approved_quantity is null or (approved_quantity > 0 and approved_quantity <= requested_quantity)),
  constraint transfers_approved_evidence check (
    status not in ('APPROVED', 'IN_TRANSIT', 'RECEIVED')
    or (approved_by is not null and approved_at is not null and approved_quantity is not null)),
  constraint transfers_dispatch_evidence check (
    status not in ('IN_TRANSIT', 'RECEIVED') or (dispatched_by is not null and dispatched_at is not null)),
  constraint transfers_receipt_evidence check (status <> 'RECEIVED' or (received_by is not null and received_at is not null)),
  constraint transfers_rejection_evidence check (status <> 'REJECTED' or (rejected_by is not null and rejection_reason is not null)),
  constraint transfers_cancel_evidence check (status <> 'CANCELLED' or cancelled_at is not null)
);
create index transfers_source_status_idx on public.transfers (source_facility_id, status);
create index transfers_destination_status_idx on public.transfers (destination_facility_id, status);
create index transfers_active_idx on public.transfers (status) where status in ('PROPOSED', 'APPROVED', 'IN_TRANSIT');
create trigger transfers_updated_at before update on public.transfers
  for each row execute function private.set_updated_at();

alter table public.transactions add constraint transactions_transfer_fkey
  foreign key (transfer_id) references public.transfers (id) on delete set null;

create table public.transfer_items (
  id                uuid primary key default gen_random_uuid(),
  transfer_id       uuid not null references public.transfers (id) on delete cascade,
  inventory_unit_id uuid not null references public.inventory_units (id) on delete restrict,
  accepted          boolean,
  created_at        timestamptz not null default now(),
  constraint transfer_items_unique unique (transfer_id, inventory_unit_id)
);
create index transfer_items_unit_idx on public.transfer_items (inventory_unit_id);

create function private.transfer_writes_allowed() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(current_setting('bloodlink.transfer_write', true), '') = 'on';
$$;

create function private.transfers_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PROPOSED' then
      raise exception 'transfers are created as PROPOSED' using errcode = 'check_violation';
    end if;
    if not private.user_has_role_at(new.initiated_by, new.destination_facility_id,
         array['BLOOD_BANK_ADMIN', 'INVENTORY_MANAGER', 'ORG_ADMIN']::public.app_role[]) then
      raise exception 'initiator must be BLOOD_BANK_ADMIN, INVENTORY_MANAGER or ORG_ADMIN at the destination'
        using errcode = 'insufficient_privilege';
    end if;
    if not (select holds_inventory from public.facilities where id = new.destination_facility_id) then
      raise exception 'destination facility does not hold inventory' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'transfers are never deleted; cancel instead' using errcode = 'insufficient_privilege';
  end if;

  if new.source_facility_id <> old.source_facility_id or new.destination_facility_id <> old.destination_facility_id
     or new.blood_group_id <> old.blood_group_id or new.component_id <> old.component_id
     or new.requested_quantity <> old.requested_quantity or new.initiated_by <> old.initiated_by then
    raise exception 'transfer route, product, requested quantity and initiator are immutable' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    if not private.transfer_writes_allowed() then
      raise exception 'transfer status changes only through the private transfer functions'
        using errcode = 'insufficient_privilege';
    end if;
    if not ((old.status = 'PROPOSED' and new.status in ('APPROVED', 'REJECTED', 'CANCELLED'))
         or (old.status = 'APPROVED' and new.status in ('IN_TRANSIT', 'CANCELLED'))
         or (old.status = 'IN_TRANSIT' and new.status = 'RECEIVED')) then
      raise exception 'invalid transfer transition % -> %', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'IN_TRANSIT'
       and (select count(*) from public.transfer_items where transfer_id = new.id) <> new.approved_quantity then
      raise exception 'dispatched unit count must equal approved_quantity' using errcode = 'check_violation';
    end if;
  elsif new.approved_quantity is distinct from old.approved_quantity and not private.transfer_writes_allowed() then
    raise exception 'approved_quantity changes only through the private transfer functions'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger transfers_guard before insert or update or delete on public.transfers
  for each row execute function private.transfers_guard();

create function private.transfer_items_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  t  public.transfers%rowtype;
  un public.inventory_units%rowtype;
begin
  if not private.transfer_writes_allowed() then
    raise exception 'transfer items change only through the private transfer functions'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    select * into t from public.transfers where id = new.transfer_id;
    select * into un from public.inventory_units where id = new.inventory_unit_id;
    if t.status <> 'APPROVED' then
      raise exception 'units are assigned only to APPROVED transfers' using errcode = 'check_violation';
    end if;
    if un.facility_id <> t.source_facility_id or un.blood_group_id <> t.blood_group_id or un.component_id <> t.component_id then
      raise exception 'unit must be at the source and match the transfer blood group and component'
        using errcode = 'check_violation';
    end if;
    if (select count(*) from public.transfer_items where transfer_id = t.id) >= t.approved_quantity then
      raise exception 'transfer already has approved_quantity units' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger transfer_items_guard before insert or update or delete on public.transfer_items
  for each row execute function private.transfer_items_guard();

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------
create function private.write_audit(
  p_actor uuid, p_organization uuid, p_facility uuid, p_action text,
  p_entity_type text, p_entity_id uuid, p_old jsonb, p_new jsonb, p_correlation uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- plpgsql so the body is resolved at run time (audit_logs is created in migration 006).
  insert into public.audit_logs (user_id, organization_id, facility_id, action, entity_type, entity_id,
    old_value, new_value, correlation_id)
  values (p_actor, p_organization, p_facility, p_action, p_entity_type, p_entity_id, p_old, p_new, p_correlation);
end;
$$;

create function private.facility_org(p_facility uuid) returns uuid
language sql stable set search_path = '' as $$
  select organization_id from public.facilities where id = p_facility;
$$;

-- Recompute a request's status from its items and allocations (§6.3).
create function private.refresh_request_status(p_request uuid, p_actor uuid, p_correlation uuid)
returns public.request_status language plpgsql security definer set search_path = '' as $$
declare
  rq            public.requests%rowtype;
  v_all_done    boolean;
  v_any_done    boolean;
  v_any_active  boolean;
  v_new         public.request_status;
begin
  select * into rq from public.requests where id = p_request for update;
  if rq.status in ('CANCELLED', 'REJECTED', 'EXPIRED') then
    return rq.status;
  end if;
  select bool_and(i.quantity_fulfilled = i.quantity_requested), bool_or(i.quantity_fulfilled > 0)
    into v_all_done, v_any_done
  from public.request_items i where i.request_id = p_request;
  select exists (select 1 from public.request_allocations a join public.request_items i on i.id = a.request_item_id
                 where i.request_id = p_request and a.status in ('RESERVED', 'CONFIRMED', 'DISPATCHED'))
    into v_any_active;

  v_new := case when v_all_done then 'FULFILLED'
                when v_any_done then 'PARTIALLY_FULFILLED'
                when v_any_active then 'ALLOCATED'
                else 'OPEN' end;
  if v_new <> rq.status then
    update public.requests set status = v_new,
      fulfilled_at = case when v_new = 'FULFILLED' then now() else null end
    where id = p_request;
    if v_new = 'FULFILLED' then
      perform private.write_audit(p_actor, private.facility_org(rq.patient_facility_id), rq.patient_facility_id,
        'request.fulfil', 'request', p_request, jsonb_build_object('status', rq.status),
        jsonb_build_object('status', v_new), p_correlation);
    end if;
  end if;
  return v_new;
end;
$$;

-- Requesting-side authority for a request (§6.5 "Who can do what").
create function private.can_act_for_request(p_actor uuid, p_request uuid, p_source uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.requests r
    where r.id = p_request and (
      private.user_has_role_at(p_actor, r.requester_facility_id,
        array['HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF']::public.app_role[])
      or private.user_has_role_at(p_actor, r.patient_facility_id,
        array['HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF']::public.app_role[])
      -- internal requests: blood-bank staff of a source in the same organization as the patient facility
      or (p_source is not null
          and private.facility_org(p_source) = private.facility_org(r.patient_facility_id)
          and private.user_has_role_at(p_actor, p_source, array['BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF']::public.app_role[]))
    ));
$$;

create function private.is_source_staff(p_actor uuid, p_source uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.user_has_role_at(p_actor, p_source, array['BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF']::public.app_role[]);
$$;

-- Lock and validate a set of allocations that must share one source and one status set.
create function private.lock_allocations(p_ids uuid[], p_allowed public.allocation_status[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_count  integer;
  v_source uuid;
  v_bad    integer;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'no allocations given' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.request_allocations where id = any (p_ids) order by id for update;
  select count(*), min(source_facility_id::text)::uuid, count(*) filter (where not (status = any (p_allowed)))
    into v_count, v_source, v_bad
  from public.request_allocations where id = any (p_ids);
  if v_count <> cardinality(p_ids) then
    raise exception 'one or more allocations not found' using errcode = 'no_data_found';
  end if;
  if (select count(distinct source_facility_id) from public.request_allocations where id = any (p_ids)) <> 1 then
    raise exception 'allocations must belong to one source facility' using errcode = 'invalid_parameter_value';
  end if;
  if v_bad > 0 then
    raise exception 'allocation status conflict' using errcode = 'serialization_failure';
  end if;
  return v_source;
end;
$$;

-- -----------------------------------------------------------------------------
-- §6.5 Source-context temporary reservation
-- -----------------------------------------------------------------------------
create function private.release_expired_holds(p_source uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  a         record;
  v_count   integer := 0;
  v_request uuid;
begin
  for a in
    select ra.*, i.request_id
    from public.request_allocations ra
    join public.request_items i on i.id = ra.request_item_id
    where ra.status = 'RESERVED' and ra.hold_expires_at < now()
      and (p_source is null or ra.source_facility_id = p_source)
    order by ra.hold_expires_at
    for update of ra skip locked
  loop
    perform set_config('bloodlink.allocation_write', 'on', true);
    update public.request_allocations
      set status = 'EXPIRED', cancelled_at = now(), cancel_reason = 'CONFIRMATION_TIMEOUT'
      where id = a.id;
    perform set_config('bloodlink.allocation_write', '', true);
    perform private.transition_unit_status(a.inventory_unit_id, 'AVAILABLE', null, p_allocation => a.id,
      p_note => 'hold expired');
    perform private.refresh_request_status(a.request_id, null, null);
    perform private.write_audit(null, private.facility_org(a.source_facility_id), a.source_facility_id,
      'allocation.hold_expire', 'request', a.request_id, null,
      jsonb_build_object('request_id', a.request_id, 'request_item_id', a.request_item_id,
                         'source_facility_id', a.source_facility_id, 'quantity', 1,
                         'reason_code', 'CONFIRMATION_TIMEOUT'), null);
    perform private.write_audit(null,
      private.facility_org((select patient_facility_id from public.requests where id = a.request_id)), null,
      'allocation.hold_expire', 'request', a.request_id, null,
      jsonb_build_object('source_facility_id', a.source_facility_id), null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function private.place_source_hold(
  p_request_item uuid, p_source_facility uuid, p_quantity integer, p_actor uuid,
  p_allow_demo_rules boolean default false, p_recommendation uuid default null, p_correlation uuid default null)
returns setof uuid language plpgsql security definer set search_path = '' as $$
declare
  it          public.request_items%rowtype;
  rq          public.requests%rowtype;
  src         public.facilities%rowtype;
  src_org     public.organizations%rowtype;
  v_remaining integer;
  v_timeout   numeric;
  v_expires   timestamptz;
  v_deadline  timestamptz;
  v_units     uuid[];
  v_unit      uuid;
  v_alloc     uuid;
  v_allocs    uuid[] := '{}';
  v_codes     text[];
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'quantity must be at least 1' using errcode = 'invalid_parameter_value';
  end if;

  -- Serialize holds for the same request item (prevents over-allocation of one item).
  select * into it from public.request_items where id = p_request_item for update;
  if not found then
    raise exception 'request item not found' using errcode = 'no_data_found';
  end if;
  select * into rq from public.requests where id = it.request_id;
  if rq.verification_status <> 'VERIFIED' or rq.status not in ('OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED') then
    raise exception 'request must be VERIFIED and open' using errcode = 'check_violation';
  end if;
  if not private.can_act_for_request(p_actor, rq.id, p_source_facility) then
    raise exception 'actor is not authorized to request a hold for this request' using errcode = 'insufficient_privilege';
  end if;

  select * into src from public.facilities where id = p_source_facility;
  select * into src_org from public.organizations where id = src.organization_id;
  if not found or not src.holds_inventory or not src.accepts_temporary_holds or src.operating_status <> 'OPERATIONAL'
     or not src_org.shares_network_availability or src_org.status not in ('VERIFIED', 'ACTIVE') then
    raise exception 'source facility does not accept temporary holds' using errcode = 'check_violation';
  end if;

  v_timeout := (private.resolve_parameter('allocation.hold_timeout_minutes', p_source_facility,
                  it.blood_group_id, it.component_id) #>> '{}')::numeric;
  if v_timeout is null or v_timeout <= 0 then
    raise exception 'allocation.hold_timeout_minutes must be a positive number' using errcode = 'check_violation';
  end if;

  v_remaining := it.quantity_requested - it.quantity_fulfilled - (
    select count(*) from public.request_allocations
    where request_item_id = it.id and status in ('RESERVED', 'CONFIRMED', 'DISPATCHED'));
  if p_quantity > v_remaining then
    raise exception 'quantity % exceeds the remaining need %', p_quantity, v_remaining using errcode = 'check_violation';
  end if;

  -- Cleanup-on-new-hold: expired holds at this source never block a new request (§6.5).
  perform private.release_expired_holds(p_source_facility);

  v_deadline := greatest(now(), coalesce(it.required_by, rq.required_by));
  select array_agg(id) into v_units from (
    select u.id
    from public.inventory_units u
    join public.compatibility_rules r
      on r.donor_blood_group_id = u.blood_group_id and r.component_id = u.component_id
    where u.facility_id = p_source_facility
      and u.status = 'AVAILABLE'
      and u.expiry_date > v_deadline
      and r.recipient_blood_group_id = it.blood_group_id
      and r.component_id = it.component_id
      and r.compatible
      and (r.validation_status = 'VALIDATED' or (r.validation_status = 'DEMO_ONLY' and p_allow_demo_rules))
      and (it.allow_compatible_substitutes or r.donor_blood_group_id = r.recipient_blood_group_id)
    order by r.priority, u.expiry_date, u.id
    limit p_quantity
    for update of u skip locked
  ) picked;

  if coalesce(cardinality(v_units), 0) < p_quantity then
    raise exception 'insufficient units at this source (% of % available)', coalesce(cardinality(v_units), 0), p_quantity
      using errcode = 'P0001', hint = 'INSUFFICIENT_UNITS';
  end if;

  v_expires := now() + make_interval(mins => v_timeout::integer);
  perform set_config('bloodlink.allow_demo_rules', case when p_allow_demo_rules then 'on' else '' end, true);
  foreach v_unit in array v_units loop
    perform set_config('bloodlink.allocation_write', 'on', true);
    insert into public.request_allocations (request_item_id, inventory_unit_id, source_facility_id,
      recommendation_id, status, allocated_by, hold_expires_at)
    values (it.id, v_unit, p_source_facility, p_recommendation, 'RESERVED', p_actor, v_expires)
    returning id into v_alloc;
    perform set_config('bloodlink.allocation_write', '', true);
    -- Executed in the source's inventory context by this function; recorded_by null = system.
    perform private.transition_unit_status(v_unit, 'RESERVED', null, p_allocation => v_alloc,
      p_reserved_for_request => rq.id, p_note => 'temporary hold for ' || rq.request_number);
    v_allocs := v_allocs || v_alloc;
  end loop;
  perform set_config('bloodlink.allow_demo_rules', '', true);

  perform private.refresh_request_status(rq.id, p_actor, p_correlation);

  select array_agg(unit_code order by unit_code) into v_codes from public.inventory_units where id = any (v_units);
  -- Requesting side: no unit codes.
  perform private.write_audit(p_actor, private.facility_org(rq.patient_facility_id), rq.patient_facility_id,
    'allocation.hold_request', 'request', rq.id, null,
    jsonb_build_object('request_item_id', it.id, 'quantity', p_quantity, 'source_facility_id', p_source_facility,
                       'hold_expires_at', v_expires), p_correlation);
  -- Source side: unit codes allowed.
  perform private.write_audit(p_actor, src.organization_id, p_source_facility, 'allocation.hold_create',
    'request', rq.id, null,
    jsonb_build_object('allocation_ids', to_jsonb(v_allocs), 'unit_codes', to_jsonb(v_codes),
                       'requesting_facility_id', coalesce(rq.requester_facility_id, rq.patient_facility_id),
                       'hold_expires_at', v_expires), p_correlation);

  return query select unnest(v_allocs);
end;
$$;

create function private.confirm_hold(p_allocations uuid[], p_actor uuid, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_source uuid;
begin
  v_source := private.lock_allocations(p_allocations, array['RESERVED']::public.allocation_status[]);
  if not private.is_source_staff(p_actor, v_source) then
    raise exception 'only blood-bank staff of the source can confirm' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.request_allocations where id = any (p_allocations) and hold_expires_at <= now()) then
    raise exception 'hold has expired; confirmation refused' using errcode = 'serialization_failure';
  end if;
  perform set_config('bloodlink.allocation_write', 'on', true);
  update public.request_allocations set status = 'CONFIRMED', confirmed_by = p_actor, confirmed_at = now()
  where id = any (p_allocations);
  perform set_config('bloodlink.allocation_write', '', true);
  perform private.write_audit(p_actor, private.facility_org(v_source), v_source, 'allocation.confirm',
    'request_allocation', null, null, jsonb_build_object('allocation_ids', to_jsonb(p_allocations)), p_correlation);
  return cardinality(p_allocations);
end;
$$;

-- Shared by decline (source) and cancel (requesting side): RESERVED → CANCELLED, units released.
create function private.end_holds(p_allocations uuid[], p_actor uuid, p_reason text, p_action text, p_correlation uuid)
returns integer language plpgsql security definer set search_path = '' as $$
-- Privacy (2026-09-25): free-text reasons may contain patient or other sensitive details, so each
-- side's text stays inside its own organization. A requester's cancel reason is kept only in the
-- requesting organization's audit entry; a source's decline reason only in the source's own
-- allocation row and ledger note. Every cross-organization record carries a structured code.
declare
  a        record;
  g        record;
  v_source uuid;
  v_code   text := case p_action when 'allocation.decline' then 'SOURCE_DECLINED' else 'REQUESTER_CANCELLED' end;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required' using errcode = 'invalid_parameter_value';
  end if;
  for a in select ra.*, i.request_id from public.request_allocations ra
           join public.request_items i on i.id = ra.request_item_id where ra.id = any (p_allocations) loop
    v_source := a.source_facility_id;
    perform set_config('bloodlink.allocation_write', 'on', true);
    update public.request_allocations set status = 'CANCELLED', cancelled_at = now(),
      -- a decline reason is the source's own text; a requester's text never reaches the source
      cancel_reason = case p_action when 'allocation.decline' then v_code || ': ' || p_reason else v_code end
    where id = a.id;
    perform set_config('bloodlink.allocation_write', '', true);
    perform private.transition_unit_status(a.inventory_unit_id, 'AVAILABLE', p_actor, p_allocation => a.id,
      p_note => case p_action when 'allocation.decline' then p_reason else v_code end);
    perform private.refresh_request_status(a.request_id, p_actor, p_correlation);
    -- Requesting organization's entry: the requester's own free text stays here; a source's
    -- decline text never does (structured code only — same principle in both directions).
    perform private.write_audit(p_actor,
      private.facility_org((select patient_facility_id from public.requests where id = a.request_id)), null,
      p_action, 'request', a.request_id, null,
      jsonb_build_object('source_facility_id', a.source_facility_id, 'reason_code', v_code)
        || case p_action when 'allocation.cancel' then jsonb_build_object('reason', p_reason) else '{}'::jsonb end,
      p_correlation);
  end loop;
  -- Source organization's entries: structured operational data only, one per request item.
  for g in select i.request_id, ra.request_item_id, count(*)::integer as quantity
           from public.request_allocations ra join public.request_items i on i.id = ra.request_item_id
           where ra.id = any (p_allocations) group by i.request_id, ra.request_item_id loop
    perform private.write_audit(p_actor, private.facility_org(v_source), v_source, p_action, 'request', g.request_id, null,
      jsonb_build_object('request_id', g.request_id, 'request_item_id', g.request_item_id,
                         'source_facility_id', v_source, 'quantity', g.quantity, 'reason_code', v_code),
      p_correlation);
  end loop;
  return cardinality(p_allocations);
end;
$$;

create function private.decline_hold(p_allocations uuid[], p_actor uuid, p_reason text, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_source uuid;
begin
  v_source := private.lock_allocations(p_allocations, array['RESERVED']::public.allocation_status[]);
  if not private.is_source_staff(p_actor, v_source) then
    raise exception 'only blood-bank staff of the source can decline' using errcode = 'insufficient_privilege';
  end if;
  return private.end_holds(p_allocations, p_actor, p_reason, 'allocation.decline', p_correlation);
end;
$$;

create function private.cancel_hold(p_allocations uuid[], p_actor uuid, p_reason text, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_source uuid;
  v_req    uuid;
begin
  v_source := private.lock_allocations(p_allocations, array['RESERVED']::public.allocation_status[]);
  for v_req in select distinct i.request_id from public.request_allocations ra
               join public.request_items i on i.id = ra.request_item_id where ra.id = any (p_allocations) loop
    if not private.can_act_for_request(p_actor, v_req, v_source) then
      raise exception 'actor cannot cancel holds for this request' using errcode = 'insufficient_privilege';
    end if;
  end loop;
  return private.end_holds(p_allocations, p_actor, p_reason, 'allocation.cancel', p_correlation);
end;
$$;

create function private.dispatch_allocation(p_allocations uuid[], p_actor uuid, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_source uuid;
  a        record;
begin
  v_source := private.lock_allocations(p_allocations, array['CONFIRMED']::public.allocation_status[]);
  if not private.is_source_staff(p_actor, v_source) then
    raise exception 'only blood-bank staff of the source can dispatch' using errcode = 'insufficient_privilege';
  end if;
  for a in select * from public.request_allocations where id = any (p_allocations) loop
    perform set_config('bloodlink.allocation_write', 'on', true);
    update public.request_allocations set status = 'DISPATCHED', dispatched_at = now() where id = a.id;
    perform set_config('bloodlink.allocation_write', '', true);
    perform private.transition_unit_status(a.inventory_unit_id, 'DISPATCHED', p_actor, p_allocation => a.id);
  end loop;
  perform private.write_audit(p_actor, private.facility_org(v_source), v_source, 'allocation.dispatch',
    'request_allocation', null, null, jsonb_build_object('allocation_ids', to_jsonb(p_allocations)), p_correlation);
  return cardinality(p_allocations);
end;
$$;

-- DISPATCHED → ISSUED; for internal requests (same organization) CONFIRMED → ISSUED directly.
create function private.issue_allocation(p_allocations uuid[], p_actor uuid, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_source uuid;
  a        record;
begin
  v_source := private.lock_allocations(p_allocations, array['DISPATCHED', 'CONFIRMED']::public.allocation_status[]);
  if not private.is_source_staff(p_actor, v_source) then
    raise exception 'only blood-bank staff of the source can record issue' using errcode = 'insufficient_privilege';
  end if;
  for a in select ra.*, i.request_id, rq.patient_facility_id from public.request_allocations ra
           join public.request_items i on i.id = ra.request_item_id
           join public.requests rq on rq.id = i.request_id
           where ra.id = any (p_allocations) loop
    if a.status = 'CONFIRMED' and private.facility_org(a.patient_facility_id) <> private.facility_org(v_source) then
      raise exception 'units for another organization must be dispatched before issue' using errcode = 'check_violation';
    end if;
    perform set_config('bloodlink.allocation_write', 'on', true);
    update public.request_allocations set status = 'ISSUED', issued_at = now() where id = a.id;
    perform set_config('bloodlink.allocation_write', '', true);
    perform private.transition_unit_status(a.inventory_unit_id, 'ISSUED', p_actor, p_allocation => a.id);
    update public.request_items set quantity_fulfilled = quantity_fulfilled + 1 where id = a.request_item_id;
    perform private.refresh_request_status(a.request_id, p_actor, p_correlation);
    perform private.write_audit(p_actor, private.facility_org(a.patient_facility_id), a.patient_facility_id,
      'allocation.issue', 'request', a.request_id, null,
      jsonb_build_object('source_facility_id', v_source), p_correlation);
  end loop;
  perform private.write_audit(p_actor, private.facility_org(v_source), v_source, 'allocation.issue',
    'request_allocation', null, null, jsonb_build_object('allocation_ids', to_jsonb(p_allocations)), p_correlation);
  return cardinality(p_allocations);
end;
$$;

create function private.return_allocation(p_allocations uuid[], p_actor uuid, p_reason text, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_source uuid;
  a        record;
begin
  v_source := private.lock_allocations(p_allocations, array['DISPATCHED', 'ISSUED']::public.allocation_status[]);
  if not private.is_source_staff(p_actor, v_source) then
    raise exception 'only blood-bank staff of the source can record a return' using errcode = 'insufficient_privilege';
  end if;
  for a in select ra.*, i.request_id from public.request_allocations ra
           join public.request_items i on i.id = ra.request_item_id where ra.id = any (p_allocations) loop
    perform set_config('bloodlink.allocation_write', 'on', true);
    update public.request_allocations set status = 'RETURNED' where id = a.id;
    perform set_config('bloodlink.allocation_write', '', true);
    perform private.transition_unit_status(a.inventory_unit_id, 'RETURNED', p_actor, p_allocation => a.id, p_note => p_reason);
    if a.status = 'ISSUED' then
      update public.request_items set quantity_fulfilled = quantity_fulfilled - 1 where id = a.request_item_id;
    end if;
    perform private.refresh_request_status(a.request_id, p_actor, p_correlation);
  end loop;
  perform private.write_audit(p_actor, private.facility_org(v_source), v_source, 'allocation.return',
    'request_allocation', null, null, jsonb_build_object('allocation_ids', to_jsonb(p_allocations), 'reason', p_reason),
    p_correlation);
  return cardinality(p_allocations);
end;
$$;

-- §9.4 (U7): bag codes of ISSUED units, only for the request's clinical participants.
create function private.issued_unit_codes(p_request uuid, p_actor uuid, p_correlation uuid default null)
returns table (unit_code text, blood_group text, component text, issued_at timestamptz, request_number text)
language plpgsql security definer set search_path = '' as $$
declare
  rq            public.requests%rowtype;
  v_participant boolean;
  v_source_only uuid[];
begin
  select * into rq from public.requests where id = p_request;
  if not found then
    raise exception 'request not found' using errcode = 'no_data_found';
  end if;
  v_participant :=
    private.user_has_role_at(p_actor, rq.patient_facility_id, array['DOCTOR', 'HOSPITAL_STAFF', 'EMERGENCY_STAFF']::public.app_role[])
    or private.user_has_role_at(p_actor, rq.requester_facility_id, array['DOCTOR', 'HOSPITAL_STAFF', 'EMERGENCY_STAFF']::public.app_role[]);
  if not v_participant then
    -- Source blood-centre staff see only units from their own facility (their own inventory).
    select array_agg(distinct ra.source_facility_id) into v_source_only
    from public.request_allocations ra join public.request_items i on i.id = ra.request_item_id
    where i.request_id = p_request and private.is_source_staff(p_actor, ra.source_facility_id);
    if v_source_only is null then
      raise exception 'not a participant in this request' using errcode = 'insufficient_privilege';
    end if;
  end if;

  perform private.write_audit(p_actor, private.facility_org(rq.patient_facility_id), rq.patient_facility_id,
    'request.view_issued_units', 'request', p_request, null, null, p_correlation);

  return query
    select u.unit_code, bg.code, c.code, ra.issued_at, rq.request_number
    from public.request_allocations ra
    join public.request_items i   on i.id = ra.request_item_id
    join public.inventory_units u on u.id = ra.inventory_unit_id
    join public.blood_groups bg   on bg.id = u.blood_group_id
    join public.components c      on c.id = u.component_id
    where i.request_id = p_request and ra.status = 'ISSUED'
      and (v_participant or ra.source_facility_id = any (v_source_only))
    order by ra.issued_at, u.unit_code;
end;
$$;

-- -----------------------------------------------------------------------------
-- §6.4 Transfer workflow — source reserves in its own inventory; destination never touches it
-- -----------------------------------------------------------------------------
create function private.lock_transfer(p_transfer uuid, p_allowed public.transfer_status[])
returns public.transfers language plpgsql security definer set search_path = '' as $$
declare t public.transfers%rowtype;
begin
  select * into t from public.transfers where id = p_transfer for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'no_data_found';
  end if;
  if not (t.status = any (p_allowed)) then
    raise exception 'transfer status conflict (%)', t.status using errcode = 'serialization_failure';
  end if;
  return t;
end;
$$;

create function private.audit_transfer(p_actor uuid, t public.transfers, p_action text, p_old jsonb, p_new jsonb, p_correlation uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.write_audit(p_actor, private.facility_org(t.source_facility_id), t.source_facility_id, p_action,
    'transfer', t.id, p_old, p_new, p_correlation);
  if private.facility_org(t.destination_facility_id) <> private.facility_org(t.source_facility_id) then
    perform private.write_audit(p_actor, private.facility_org(t.destination_facility_id), t.destination_facility_id,
      p_action, 'transfer', t.id, p_old, p_new, p_correlation);
  end if;
end;
$$;

create function private.approve_transfer(p_transfer uuid, p_actor uuid, p_approved_quantity integer, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  t       public.transfers%rowtype;
  v_units uuid[];
  v_unit  uuid;
begin
  t := private.lock_transfer(p_transfer, array['PROPOSED']::public.transfer_status[]);
  if not private.user_has_role_at(p_actor, t.source_facility_id, array['BLOOD_BANK_ADMIN']::public.app_role[]) then
    raise exception 'only the source BLOOD_BANK_ADMIN can approve' using errcode = 'insufficient_privilege';
  end if;
  if p_approved_quantity is null or p_approved_quantity < 1 or p_approved_quantity > t.requested_quantity then
    raise exception 'approved quantity must be between 1 and %', t.requested_quantity using errcode = 'check_violation';
  end if;

  select array_agg(id) into v_units from (
    select u.id from public.inventory_units u
    where u.facility_id = t.source_facility_id and u.status = 'AVAILABLE' and u.expiry_date > now()
      and u.blood_group_id = t.blood_group_id and u.component_id = t.component_id
    order by u.expiry_date, u.id
    limit p_approved_quantity
    for update skip locked
  ) picked;
  if coalesce(cardinality(v_units), 0) < p_approved_quantity then
    raise exception 'insufficient units at source (% of %)', coalesce(cardinality(v_units), 0), p_approved_quantity
      using errcode = 'P0001', hint = 'INSUFFICIENT_UNITS';
  end if;

  perform set_config('bloodlink.transfer_write', 'on', true);
  update public.transfers set status = 'APPROVED', approved_by = p_actor, approved_at = now(),
    approved_quantity = p_approved_quantity where id = t.id;
  foreach v_unit in array v_units loop
    insert into public.transfer_items (transfer_id, inventory_unit_id) values (t.id, v_unit);
    perform private.transition_unit_status(v_unit, 'RESERVED', p_actor, p_transfer => t.id,
      p_counterpart => t.destination_facility_id);
  end loop;
  perform set_config('bloodlink.transfer_write', '', true);
  perform private.audit_transfer(p_actor, t, 'transfer.approve', jsonb_build_object('status', 'PROPOSED'),
    jsonb_build_object('status', 'APPROVED', 'approved_quantity', p_approved_quantity), p_correlation);
  return p_approved_quantity;
end;
$$;

create function private.reject_transfer(p_transfer uuid, p_actor uuid, p_reason text, p_correlation uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.transfers%rowtype;
begin
  t := private.lock_transfer(p_transfer, array['PROPOSED']::public.transfer_status[]);
  if not private.user_has_role_at(p_actor, t.source_facility_id, array['BLOOD_BANK_ADMIN']::public.app_role[]) then
    raise exception 'only the source BLOOD_BANK_ADMIN can reject' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('bloodlink.transfer_write', 'on', true);
  update public.transfers set status = 'REJECTED', rejected_by = p_actor, rejection_reason = p_reason where id = t.id;
  perform set_config('bloodlink.transfer_write', '', true);
  perform private.audit_transfer(p_actor, t, 'transfer.reject', jsonb_build_object('status', 'PROPOSED'),
    jsonb_build_object('status', 'REJECTED', 'reason', p_reason), p_correlation);
end;
$$;

create function private.dispatch_transfer(p_transfer uuid, p_actor uuid, p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  t      public.transfers%rowtype;
  v_unit uuid;
  v_n    integer := 0;
begin
  t := private.lock_transfer(p_transfer, array['APPROVED']::public.transfer_status[]);
  if not private.is_source_staff(p_actor, t.source_facility_id) then
    raise exception 'only blood-bank staff of the source can dispatch' using errcode = 'insufficient_privilege';
  end if;
  for v_unit in select inventory_unit_id from public.transfer_items where transfer_id = t.id loop
    perform private.transition_unit_status(v_unit, 'IN_TRANSIT', p_actor, p_transfer => t.id,
      p_counterpart => t.destination_facility_id);
    v_n := v_n + 1;
  end loop;
  perform set_config('bloodlink.transfer_write', 'on', true);
  update public.transfers set status = 'IN_TRANSIT', dispatched_by = p_actor, dispatched_at = now() where id = t.id;
  perform set_config('bloodlink.transfer_write', '', true);
  perform private.audit_transfer(p_actor, t, 'transfer.dispatch', jsonb_build_object('status', 'APPROVED'),
    jsonb_build_object('status', 'IN_TRANSIT', 'units', v_n), p_correlation);
  return v_n;
end;
$$;

create function private.receive_transfer(p_transfer uuid, p_actor uuid, p_rejected_units uuid[] default '{}',
  p_correlation uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  t          public.transfers%rowtype;
  v_unit     uuid;
  v_accepted integer := 0;
begin
  t := private.lock_transfer(p_transfer, array['IN_TRANSIT']::public.transfer_status[]);
  if not private.user_has_role_at(p_actor, t.destination_facility_id,
       array['BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER']::public.app_role[]) then
    raise exception 'only staff of the destination can receive' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('bloodlink.transfer_write', 'on', true);
  for v_unit in select inventory_unit_id from public.transfer_items where transfer_id = t.id loop
    perform private.transition_unit_status(v_unit, 'RECEIVED', p_actor, p_to_facility => t.destination_facility_id,
      p_transfer => t.id, p_counterpart => t.source_facility_id);
    if v_unit = any (coalesce(p_rejected_units, '{}')) then
      perform private.transition_unit_status(v_unit, 'QUARANTINED', p_actor, p_transfer => t.id,
        p_note => 'rejected on arrival');
      update public.transfer_items set accepted = false where transfer_id = t.id and inventory_unit_id = v_unit;
    else
      perform private.transition_unit_status(v_unit, 'AVAILABLE', p_actor, p_transfer => t.id);
      update public.transfer_items set accepted = true where transfer_id = t.id and inventory_unit_id = v_unit;
      v_accepted := v_accepted + 1;
    end if;
  end loop;
  update public.transfers set status = 'RECEIVED', received_by = p_actor, received_at = now() where id = t.id;
  perform set_config('bloodlink.transfer_write', '', true);
  perform private.audit_transfer(p_actor, t, 'transfer.receive', jsonb_build_object('status', 'IN_TRANSIT'),
    jsonb_build_object('status', 'RECEIVED', 'accepted', v_accepted), p_correlation);
  return v_accepted;
end;
$$;

create function private.cancel_transfer(p_transfer uuid, p_actor uuid, p_reason text, p_correlation uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t      public.transfers%rowtype;
  v_unit uuid;
begin
  t := private.lock_transfer(p_transfer, array['PROPOSED', 'APPROVED']::public.transfer_status[]);
  if not (private.user_has_role_at(p_actor, t.destination_facility_id,
            array['BLOOD_BANK_ADMIN', 'INVENTORY_MANAGER', 'ORG_ADMIN']::public.app_role[])
          or private.user_has_role_at(p_actor, t.source_facility_id, array['BLOOD_BANK_ADMIN']::public.app_role[])) then
    raise exception 'actor cannot cancel this transfer' using errcode = 'insufficient_privilege';
  end if;
  for v_unit in select inventory_unit_id from public.transfer_items where transfer_id = t.id loop
    perform private.transition_unit_status(v_unit, 'AVAILABLE', p_actor, p_transfer => t.id, p_note => p_reason);
  end loop;
  perform set_config('bloodlink.transfer_write', 'on', true);
  update public.transfers set status = 'CANCELLED', cancelled_at = now() where id = t.id;
  perform set_config('bloodlink.transfer_write', '', true);
  perform private.audit_transfer(p_actor, t, 'transfer.cancel', jsonb_build_object('status', t.status),
    jsonb_build_object('status', 'CANCELLED', 'reason', p_reason), p_correlation);
end;
$$;

-- -----------------------------------------------------------------------------
-- Expiry job (§5.3): past-expiry units → EXPIRED. Units held by an active allocation or
-- an active transfer are left for staff to resolve (they are still excluded from `usable`).
-- -----------------------------------------------------------------------------
create function private.expire_units() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_unit  uuid;
  v_count integer := 0;
begin
  for v_unit in
    select u.id from public.inventory_units u
    where u.expiry_date <= now()
      and u.status in ('AVAILABLE', 'QUARANTINED', 'RECEIVED', 'RESERVED')
      and not exists (select 1 from public.request_allocations a
                      where a.inventory_unit_id = u.id and a.status in ('RESERVED', 'CONFIRMED', 'DISPATCHED'))
      and not exists (select 1 from public.transfer_items ti join public.transfers t on t.id = ti.transfer_id
                      where ti.inventory_unit_id = u.id and t.status in ('APPROVED', 'IN_TRANSIT'))
    for update of u skip locked
  loop
    perform private.transition_unit_status(v_unit, 'EXPIRED', null, p_note => 'expiry job');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
