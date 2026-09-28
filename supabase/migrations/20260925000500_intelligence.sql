-- =============================================================================
-- 005 · Intelligence: predictions, recommendations, alerts, donor_activations,
-- donor_activation_recipients; deferred FKs; backend-only network aggregate (§10.3).
-- Source: proposal §3.18–3.22, §7, §8, §10.3. No predictions/recommendations are seeded:
-- they are produced by the AI pipeline from real records.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- predictions (§3.18) — forecasts only; no recommendation fields (D3)
-- -----------------------------------------------------------------------------
create table public.predictions (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null,
  organization_id        uuid not null,
  facility_id            uuid not null,
  blood_group_id         smallint not null references public.blood_groups (id) on delete restrict,
  component_id           smallint not null references public.components (id) on delete restrict,
  prediction_type        public.prediction_type not null,
  horizon_days           smallint not null check (horizon_days between 1 and 90),
  period_start           date not null,
  period_end             date not null,
  predicted_daily_demand numeric(8,3),
  predicted_quantity     numeric(10,3),
  usable_units           integer,
  reserved_units         integer,
  pending_request_units  integer,
  incoming_units         integer,
  expiring_units         integer,
  at_risk_units          integer,
  days_of_cover          numeric(6,2),
  predicted_shortage_date date,
  shortage_risk          public.risk_level,
  confidence_score       numeric(4,3) check (confidence_score between 0 and 1),
  confidence_method      text,
  explanation            jsonb not null default '{}',
  model_name             text not null,
  model_version          text not null,
  generated_at           timestamptz not null default now(),
  superseded_at          timestamptz,
  constraint predictions_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict,
  constraint predictions_period check (period_end >= period_start),
  constraint predictions_confidence_method check ((confidence_score is null) = (confidence_method is null))
);
create unique index predictions_one_current_per_series
  on public.predictions (facility_id, blood_group_id, component_id, prediction_type, horizon_days)
  where superseded_at is null;
create index predictions_org_generated_idx on public.predictions (organization_id, generated_at desc);
create index predictions_run_idx on public.predictions (run_id);

-- -----------------------------------------------------------------------------
-- recommendations (§3.22) — AI proposals needing a human decision (decision F)
-- -----------------------------------------------------------------------------
create table public.recommendations (
  id                    uuid primary key default gen_random_uuid(),
  recommendation_type   public.recommendation_type not null,
  organization_id       uuid not null references public.organizations (id) on delete restrict,
  facility_id           uuid,
  related_prediction_id uuid references public.predictions (id) on delete set null,
  related_request_id    uuid references public.requests (id) on delete set null,
  status                public.recommendation_status not null default 'PENDING',
  priority              public.risk_level not null,
  payload               jsonb not null,
  modified_payload      jsonb,
  what_explanation      text not null,
  why_explanation       text not null,
  data_explanation      jsonb not null,
  action_explanation    text not null,
  source                public.recommendation_source not null default 'AI_SERVICE',
  model_version         text,
  dedupe_key            text not null,
  valid_until           timestamptz not null,
  decided_by            uuid references public.users (id) on delete restrict,
  decided_at            timestamptz,
  decision_note         text,
  executed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint recommendations_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict,
  constraint recommendations_decision_evidence check (
    status in ('PENDING', 'EXPIRED') or (decided_by is not null and decided_at is not null)),
  constraint recommendations_modified_payload check (status <> 'MODIFIED' or modified_payload is not null),
  constraint recommendations_decision_note check (status not in ('MODIFIED', 'REJECTED') or decision_note is not null),
  constraint recommendations_executed_at check (status <> 'EXECUTED' or executed_at is not null)
);
create unique index recommendations_one_pending_per_subject
  on public.recommendations (organization_id, dedupe_key) where status = 'PENDING';
create index recommendations_org_status_priority_idx on public.recommendations (organization_id, status, priority);
create index recommendations_prediction_idx on public.recommendations (related_prediction_id);
create trigger recommendations_updated_at before update on public.recommendations
  for each row execute function private.set_updated_at();

alter table public.request_allocations add constraint request_allocations_recommendation_fkey
  foreign key (recommendation_id) references public.recommendations (id) on delete set null;
alter table public.transfers add constraint transfers_recommendation_fkey
  foreign key (recommendation_id) references public.recommendations (id) on delete set null;

-- -----------------------------------------------------------------------------
-- alerts (§3.19)
-- -----------------------------------------------------------------------------
create table public.alerts (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations (id) on delete restrict,
  facility_id          uuid,
  alert_type           public.alert_type not null,
  severity             public.risk_level not null,
  title                text not null,
  message              text not null,
  source_prediction_id uuid references public.predictions (id) on delete set null,
  recommendation_id    uuid references public.recommendations (id) on delete set null,
  request_id           uuid references public.requests (id) on delete set null,
  transfer_id          uuid references public.transfers (id) on delete set null,
  dedupe_key           text,
  status               public.alert_status not null default 'UNREAD',
  acknowledged_by      uuid references public.users (id) on delete set null,
  acknowledged_at      timestamptz,
  resolved_by          uuid references public.users (id) on delete set null,
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  constraint alerts_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict
);
create unique index alerts_one_open_per_subject on public.alerts (organization_id, dedupe_key) where status <> 'RESOLVED';
create index alerts_org_status_created_idx on public.alerts (organization_id, status, created_at desc);

-- -----------------------------------------------------------------------------
-- donor_activations (§3.20) and donor_activation_recipients (§3.21)
-- -----------------------------------------------------------------------------
create table public.donor_activations (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  facility_id        uuid not null,
  prediction_id      uuid references public.predictions (id) on delete set null,
  recommendation_id  uuid references public.recommendations (id) on delete set null,
  blood_group_id     smallint not null references public.blood_groups (id) on delete restrict,
  component_id       smallint not null references public.components (id) on delete restrict,
  units_needed       smallint not null check (units_needed > 0),
  target_donor_count smallint not null check (target_donor_count > 0),
  urgency            public.urgency_level not null default 'HIGH',
  radius_km          numeric(5,1) not null check (radius_km > 0),
  donor_message      text not null,
  status             public.donor_activation_status not null default 'ACTIVE',
  activated_by       uuid not null references public.users (id) on delete restrict,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint donor_activations_facility_in_org foreign key (facility_id, organization_id)
    references public.facilities (id, organization_id) on delete restrict
);
create index donor_activations_org_status_idx on public.donor_activations (organization_id, status);
create index donor_activations_group_status_idx on public.donor_activations (blood_group_id, status);
create trigger donor_activations_updated_at before update on public.donor_activations
  for each row execute function private.set_updated_at();

create table public.donor_activation_recipients (
  id                  uuid primary key default gen_random_uuid(),
  activation_id       uuid not null references public.donor_activations (id) on delete cascade,
  donor_id            uuid not null references public.donors (id) on delete restrict,
  distance_km         numeric(5,1) not null check (distance_km >= 0),
  notification_status public.notification_status not null default 'PENDING',
  notified_at         timestamptz,
  response            public.donor_response not null default 'NO_RESPONSE',
  responded_at        timestamptz,
  created_at          timestamptz not null default now(),
  constraint donor_activation_recipients_unique unique (activation_id, donor_id)
);
create index donor_activation_recipients_donor_idx on public.donor_activation_recipients (donor_id, created_at desc);

alter table public.donations add constraint donations_activation_recipient_fkey
  foreign key (activation_recipient_id) references public.donor_activation_recipients (id) on delete set null;

-- -----------------------------------------------------------------------------
-- §10.3 Network visibility — backend-only aggregate. Returns ONLY the approved minimum
-- fields (U1): facility identity, can_fulfil, spare units above reserve, near-expiry flag.
-- Never returns unit IDs/codes, expiry dates, storage, requests, demand or cover.
-- Spare above reserve per donor group = usable − pending (own-organization verified demand)
--   − ceil(reserve.floor_days × current forecast demand); requires a current DEMAND or
--   SHORTAGE prediction and a configured reserve.floor_days, otherwise the facility is omitted.
-- -----------------------------------------------------------------------------
create function private.network_availability(
  p_actor uuid, p_recipient_group smallint, p_component smallint, p_quantity integer,
  p_allow_substitutes boolean default true, p_allow_demo_rules boolean default false)
returns table (
  facility_id uuid, facility_name text, organization_name text, facility_type public.facility_type,
  latitude double precision, longitude double precision,
  can_fulfil boolean, spare_units_above_reserve integer, near_expiry_opportunity boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Caller must be staff in a VERIFIED/ACTIVE organization (never PUBLIC_REQUESTER / DONOR).
  if not exists (
    select 1 from public.user_roles g
    join public.roles r on r.id = g.role_id
    join public.users u on u.id = g.user_id and u.status = 'ACTIVE'
    join public.organizations o on o.id = g.organization_id and o.status in ('VERIFIED', 'ACTIVE')
    where g.user_id = p_actor
      and r.code in ('ORG_ADMIN', 'HOSPITAL_STAFF', 'DOCTOR', 'EMERGENCY_STAFF',
                     'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER')) then
    raise exception 'network availability is restricted to organization staff' using errcode = 'insufficient_privilege';
  end if;

  return query
  with sources as (
    select f.id, f.name, o.name as org_name, f.facility_type, f.latitude, f.longitude, f.organization_id
    from public.facilities f
    join public.organizations o on o.id = f.organization_id
    where f.holds_inventory and f.operating_status = 'OPERATIONAL'
      and o.shares_network_availability and o.status in ('VERIFIED', 'ACTIVE')
  ), groups as (
    select r.donor_blood_group_id as blood_group_id
    from public.compatibility_rules r
    where r.recipient_blood_group_id = p_recipient_group and r.component_id = p_component and r.compatible
      and (r.validation_status = 'VALIDATED' or (r.validation_status = 'DEMO_ONLY' and p_allow_demo_rules))
      and (p_allow_substitutes or r.donor_blood_group_id = r.recipient_blood_group_id)
  ), per_group as (
    select s.id as facility_id, g.blood_group_id,
      (select count(*) from public.inventory_units u
        where u.facility_id = s.id and u.blood_group_id = g.blood_group_id and u.component_id = p_component
          and u.status = 'AVAILABLE' and u.expiry_date > now())::integer as usable,
      (select coalesce(sum(i.quantity_requested - i.quantity_fulfilled
                           - (select count(*) from public.request_allocations a
                              where a.request_item_id = i.id and a.status in ('RESERVED', 'CONFIRMED', 'DISPATCHED'))), 0)
        from public.request_items i
        join public.requests rq on rq.id = i.request_id
        join public.facilities pf on pf.id = rq.patient_facility_id
        where pf.organization_id = s.organization_id and rq.verification_status = 'VERIFIED'
          and rq.status in ('OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED')
          and i.blood_group_id = g.blood_group_id and i.component_id = p_component)::integer as pending,
      (select p.predicted_daily_demand from public.predictions p
        where p.facility_id = s.id and p.blood_group_id = g.blood_group_id and p.component_id = p_component
          and p.prediction_type in ('DEMAND', 'SHORTAGE') and p.superseded_at is null
          and p.predicted_daily_demand is not null
        order by p.generated_at desc limit 1) as demand,
      (select coalesce(sum(p.at_risk_units), 0) from public.predictions p
        where p.facility_id = s.id and p.blood_group_id = g.blood_group_id and p.component_id = p_component
          and p.prediction_type = 'EXPIRY' and p.superseded_at is null)::integer as at_risk,
      (select (pp.value #>> '{}')::numeric from public.planning_parameters pp
        where pp.key = 'reserve.floor_days'
          and (pp.facility_id is null or pp.facility_id = s.id)
          and (pp.organization_id is null or pp.organization_id = s.organization_id)
          and (pp.blood_group_id is null or pp.blood_group_id = g.blood_group_id)
          and (pp.component_id is null or pp.component_id = p_component)
        order by (pp.facility_id is not null) desc, (pp.organization_id is not null) desc,
                 (pp.blood_group_id is not null) desc, (pp.component_id is not null) desc
        limit 1) as floor_days
    from sources s cross join groups g
  ), spare as (
    select pg.facility_id,
      sum(greatest(pg.usable - pg.pending - ceil(pg.floor_days * pg.demand)::integer, 0))::integer as spare_units,
      bool_or(pg.at_risk > 0) as near_expiry,
      bool_and(pg.demand is not null and pg.floor_days is not null) as computable
    from per_group pg group by pg.facility_id
  )
  select s.id, s.name, s.org_name, s.facility_type, s.latitude, s.longitude,
         sp.spare_units >= p_quantity, sp.spare_units, sp.near_expiry
  from sources s join spare sp on sp.facility_id = s.id
  where sp.computable;
end;
$$;
