# BloodLink — Proposed Database Schema (Phase 3, for review)

**Status:** PROPOSAL, revision 4 — includes all review decisions of 2026-09-25 (decisions 1–6, U1–U8, C1–C12).
See §19 Decision reconciliation, §20 Open issues, §21 Final consistency review.
Not implemented: no migrations, no Supabase changes, no Prisma schema, no seed.
**Sources:** `docs/spec/01–05`, `docs/DECISIONS.md` (A–M), approved workflows, current frontend.
**Target:** PostgreSQL 15+ on hosted Supabase. SQL migrations are the source of truth; Prisma is
generated later with `prisma db pull`.

Legend used in every table:

- **★** field/table not explicitly present in the Step 3 spec (listed again in §13)
- **MVP** needed for the hackathon demo path · **FR** future-ready (column exists, may stay null in MVP)
- `now()` = `now()`; `uuid()` = `gen_random_uuid()`

---

## 1. Schema overview

### Conventions

| Topic | Convention |
|---|---|
| Schemas | Application tables in `public`. RLS helper functions in `private` (not exposed by the Supabase Data API). Identity in Supabase's `auth`. |
| Primary keys | `uuid` default `gen_random_uuid()`; small reference tables (`blood_groups`, `components`, `roles`) use `smallint generated always as identity`. |
| Timestamps | `timestamptz`, stored in UTC. `created_at` / `updated_at` default `now()`; `updated_at` maintained by a shared `set_updated_at()` trigger. Business "days" (daily demand) use **Asia/Kolkata**. |
| ON UPDATE | Keys never change → every FK is `ON UPDATE NO ACTION` (default). Not repeated per table below. |
| ON DELETE | Operational history is never hard-deleted: parents use `RESTRICT`. `CASCADE` only for pure child rows of a parent (items of a request, recipients of an activation, roles of a user). `SET NULL` for optional "related-to" links. Deactivation is done with status columns. |
| Money / clinical numbers | `numeric(p,s)` for stored AI outputs and temperatures (reproducible, exact); `double precision` for coordinates. |
| Integrity across tenants | Composite FKs such as `(facility_id, organization_id) → facilities(id, organization_id)` guarantee a facility belongs to the stated organization. |
| Writes | Browsers never write tables directly. All writes go through Express (Prisma, privileged connection) which enforces authorization, then RLS covers direct reads and Realtime. |

### Tables (25 required + 1 proposed)

| # | Table | Domain | Tier |
|---|---|---|---|
| 1 | organizations | Tenancy | MVP |
| 2 | facilities | Tenancy | MVP |
| 3 | users | Identity | MVP |
| 4 | roles | Identity | MVP |
| 5 | user_roles | Identity | MVP |
| 6 | blood_groups | Reference | MVP |
| 7 | components | Reference | MVP |
| 8 | storage_locations | Inventory | MVP (moved up from Step 3 Tier 2 — see §16) |
| 9 | inventory_units | Inventory | MVP |
| 10 | donors | Donors | MVP |
| 11 | donations | Donors | MVP |
| 12 | donation_components | Donors | MVP |
| 13 | requests | Requests | MVP |
| 14 | request_items | Requests | MVP |
| 15 | request_allocations | Requests | MVP |
| 16 | transfers | Transfers | MVP |
| 17 | transfer_items | Transfers | MVP |
| 18 | predictions | Intelligence | MVP |
| 19 | alerts | Intelligence | MVP |
| 20 | donor_activations | Mobilize | MVP (decision E) |
| 21 | donor_activation_recipients | Mobilize | MVP (decision E) |
| 22 | recommendations | Intelligence | MVP (decision F) |
| 23 | transactions | Ledger | MVP |
| 24 | audit_logs | Security | MVP (moved up from Tier 2 — see §16) |
| 25 | compatibility_rules | Reference | MVP (decision E) |
| 26 | ★ planning_parameters | Configuration | Additional table — **approved** (decision 1) |

Plus two read-only **views** (not tables): `v_inventory_summary` (§5) and `v_daily_consumption` (§7).

---

## 2. Enums

Only domains that are closed, stable and used in constraints or RLS are enums. Free-form or
fast-changing values (audit actions, component codes, blood group codes) are rows or text.

| # | Enum | Values | Used in |
|---|---|---|---|
| 1 | `organization_type` | HOSPITAL, BLOOD_CENTRE, HOSPITAL_BLOOD_CENTRE, CLINIC, NURSING_HOME, OTHER_AUTHORIZED_PROVIDER | organizations.type |
| 2 | `organization_status` | PENDING, VERIFIED, ACTIVE, SUSPENDED | organizations.status |
| 3 | `facility_type` ★ | HOSPITAL, BLOOD_CENTRE, CLINIC, NURSING_HOME, EMERGENCY_SERVICE, OTHER | facilities.facility_type |
| 4 | `facility_operating_status` ★ | OPERATIONAL, TEMPORARILY_CLOSED, INACTIVE | facilities.operating_status |
| 5 | `user_status` ★ | INVITED, ACTIVE, SUSPENDED, DEACTIVATED | users.status |
| 6 | `app_role` | SUPER_ADMIN, ORG_ADMIN, HOSPITAL_STAFF, DOCTOR, EMERGENCY_STAFF, BLOOD_BANK_ADMIN, BLOOD_BANK_STAFF, INVENTORY_MANAGER, DONOR, PUBLIC_REQUESTER | roles.code, RLS helpers |
| 7 | `role_scope` ★ | PLATFORM, ORGANIZATION, FACILITY, SELF | roles.scope |
| 8 | `component_category` ★ | WHOLE_BLOOD, RED_CELLS, PLASMA, PLATELETS, CRYOPRECIPITATE | components.category |
| 9 | `storage_location_type` ★ | REFRIGERATOR, FREEZER, PLATELET_INCUBATOR, QUARANTINE_AREA, OTHER | storage_locations.type |
| 10 | `storage_location_status` ★ | ACTIVE, MAINTENANCE, OUT_OF_SERVICE | storage_locations.status |
| 11 | `inventory_unit_status` | AVAILABLE, RESERVED, DISPATCHED, IN_TRANSIT, RECEIVED, ISSUED, RETURNED, WASTED, EXPIRED, QUARANTINED | inventory_units.status, transactions.from_status/to_status |
| 12 | `donor_availability` ★ | AVAILABLE, TEMPORARILY_UNAVAILABLE, UNAVAILABLE | donors.availability_status |
| 13 | `donor_status` | ACTIVE, DEFERRED, INACTIVE | donors.status |
| 14 | `donation_type` | WHOLE_BLOOD, APHERESIS_PLATELETS, APHERESIS_PLASMA | donations.donation_type |
| 15 | `screening_status` ★ | PENDING, PASSED, FAILED | donations.screening_status |
| 16 | `eligibility_status` ★ | PENDING, ELIGIBLE, TEMPORARILY_DEFERRED, PERMANENTLY_DEFERRED | donations.eligibility_status |
| 17 | `processing_status` ★ | PENDING, PROCESSED, DISCARDED | donation_components.processing_status |
| 18 | `request_type` | EMERGENCY, ROUTINE, BULK | requests.request_type |
| 19 | `urgency_level` | CRITICAL, HIGH, NORMAL | requests.urgency, request_items.urgency, donor_activations.urgency |
| 20 | `verification_status` | PENDING_VERIFICATION, VERIFIED, REJECTED | requests.verification_status |
| 20a | `verification_method` ★ | STAFF_AT_CREATION, STAFF_REVIEW | requests.verification_method — distinguishes a request verified by its authorized creator from one reviewed by a second person (decision 2) |
| 21 | `request_status` ★ | OPEN, ALLOCATED, PARTIALLY_FULFILLED, FULFILLED, CANCELLED, REJECTED, EXPIRED | requests.status |
| 22 | `allocation_status` ★ | RESERVED (temporary source-context hold awaiting source confirmation), CONFIRMED, DISPATCHED, ISSUED, CANCELLED, EXPIRED (hold timed out), RETURNED | request_allocations.status |
| 23 | `transfer_status` | PROPOSED, APPROVED, IN_TRANSIT, RECEIVED, REJECTED, CANCELLED | transfers.status |
| 24 | `prediction_type` | DEMAND, SHORTAGE, EXPIRY *(PROCUREMENT removed — D4 approved)* | predictions.prediction_type |
| 25 | `risk_level` | CRITICAL, HIGH, MEDIUM, LOW | predictions.shortage_risk, alerts.severity, recommendations.priority |
| 26 | `alert_type` | SHORTAGE, EXPIRY, EMERGENCY, DONOR, TRANSFER | alerts.alert_type |
| 27 | `alert_status` | UNREAD, ACKNOWLEDGED, RESOLVED | alerts.status |
| 28 | `donor_activation_status` ★ | ACTIVE, FULFILLED, CANCELLED, EXPIRED | donor_activations.status |
| 29 | `notification_status` | PENDING, SENT, DELIVERED, FAILED | donor_activation_recipients.notification_status |
| 30 | `donor_response` ★ | NO_RESPONSE, WILLING, DECLINED | donor_activation_recipients.response |
| 31 | `recommendation_type` ★ | REDISTRIBUTION, PROCUREMENT, EMERGENCY_SOURCE, DONOR_ACTIVATION | recommendations.recommendation_type |
| 32 | `recommendation_status` | PENDING, APPROVED, MODIFIED, REJECTED, EXPIRED, EXECUTED | recommendations.status |
| 33 | `recommendation_source` ★ | AI_SERVICE, SYSTEM_RULE | recommendations.source |
| 34 | `transaction_type` | COMPONENT_CREATED, INVENTORY_ADDED, PROCUREMENT_RECEIVED, ★ INVENTORY_QUARANTINED, ★ INVENTORY_ACCEPTED, INVENTORY_RESERVED, INVENTORY_RELEASED, ★ INVENTORY_DISPATCHED, INVENTORY_ISSUED, INVENTORY_RETURNED, TRANSFER_DISPATCHED, TRANSFER_RECEIVED, INVENTORY_WASTED, INVENTORY_EXPIRED — 14 values, **unit lifecycle events only**. Step 3's REQUEST_FULFILLED (D6) and DONATION_RECEIVED (U3) are removed. Mapping in §11.1 | transactions.transaction_type |
| 35 | `rule_validation_status` ★ | DEMO_ONLY, VALIDATED, RETIRED | compatibility_rules.validation_status (decision 4) |

UI note: the frontend's `healthy` risk level maps to `LOW`.

---

## 3. Table-by-table schema

### 3.1 organizations
Top-level entity using BloodLink. One organization operates one or more facilities.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| name | text | NO | | CHECK length 2–200 | MVP |
| type | organization_type | NO | | | MVP |
| registration_number | text | YES | | UNIQUE (where not null) | MVP |
| licence_number | text | YES | | required for blood-centre types once VERIFIED/ACTIVE (CHECK) | MVP |
| phone | text | YES | | | MVP |
| email | text | YES | | CHECK basic email pattern | MVP |
| website | text | YES | | | FR |
| status | organization_status | NO | 'PENDING' | | MVP |
| shares_network_availability ★ | boolean | NO | false | opt-in: aggregate availability visible to network for source ranking/redistribution | MVP |
| verified_at ★ | timestamptz | YES | | set when status leaves PENDING | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- CHECK `licence_number IS NOT NULL OR type NOT IN ('BLOOD_CENTRE','HOSPITAL_BLOOD_CENTRE') OR status IN ('PENDING','SUSPENDED')`
- Indexes: `(type, status)`.

### 3.2 facilities
A physical operating location. Distance/ETA, inventory ownership and source ranking are per facility.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| organization_id | uuid | NO | | FK → organizations(id) ON DELETE RESTRICT | MVP |
| name | text | NO | | UNIQUE (organization_id, name) | MVP |
| facility_type | facility_type ★ | NO | | spec field; enum values are new | MVP |
| holds_inventory ★ | boolean | NO | false | only facilities with blood storage own inventory_units (C2: explicit opt-in) | MVP |
| accepts_temporary_holds ★ | boolean | NO | false | the source facility's explicit consent that verified requests may place time-limited holds on its eligible units through the backend workflow (§6.5) | MVP |
| address | text | NO | | | MVP |
| city | text | NO | | | MVP |
| district | text | YES | | | MVP |
| state | text | NO | | | MVP |
| pincode | text | YES | | CHECK `pincode ~ '^[1-9][0-9]{5}$'` (India) | MVP |
| latitude | double precision | NO | | CHECK −90..90 | MVP |
| longitude | double precision | NO | | CHECK −180..180 | MVP |
| phone | text | YES | | | MVP |
| operating_status | facility_operating_status | NO | 'OPERATIONAL' | | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- UNIQUE `(id, organization_id)` — target of composite FKs.
- Trigger (validation): facility type must fit the organization type — HOSPITAL org → HOSPITAL facilities only; BLOOD_CENTRE org → BLOOD_CENTRE only; HOSPITAL_BLOOD_CENTRE → HOSPITAL and BLOOD_CENTRE; CLINIC/NURSING_HOME/OTHER → matching type or EMERGENCY_SERVICE.
- Indexes: `(organization_id)`, `(facility_type, operating_status)`.
- **How the three org shapes map:** Hospital only → one+ HOSPITAL facilities (may `holds_inventory` for hospital storage). Blood Centre only → one+ BLOOD_CENTRE facilities. Hospital + Blood Centre → one organization with a HOSPITAL facility *and* a BLOOD_CENTRE facility (ABC Hospital + Centre A) — one workspace, one tenant.

### 3.3 users
Application profile for a Supabase Auth identity. **No password or password_hash column** (decision C).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | | PK, FK → auth.users(id) ON DELETE RESTRICT (deactivate, never delete) | MVP |
| organization_id | uuid | YES | | FK → organizations(id) RESTRICT. Null for SUPER_ADMIN, DONOR, PUBLIC_REQUESTER | MVP |
| facility_id | uuid | YES | | primary facility; composite FK (facility_id, organization_id) → facilities(id, organization_id) | MVP |
| full_name | text | NO | | spec "name" | MVP |
| email | text | NO | | copy of auth email for display; UNIQUE (lower(email)) | MVP |
| phone | text | YES | | | MVP |
| status | user_status | NO | 'INVITED' | | MVP |
| last_login_at | timestamptz | YES | | | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- CHECK `facility_id IS NULL OR organization_id IS NOT NULL`.
- Index: `(organization_id)`.

### 3.4 roles
Reference list of independent permission sets (decision D — no hierarchy, no parent column).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | smallint | NO | identity | PK | MVP |
| code | app_role | NO | | UNIQUE | MVP |
| name | text | NO | | display name | MVP |
| description | text | YES | | | MVP |
| scope ★ | role_scope | NO | | which org/facility link a grant requires (§9) | MVP |

Seeded with exactly the 10 approved roles.

### 3.5 user_roles
Many-to-many user ↔ role, optionally scoped to one facility.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| user_id | uuid | NO | | FK → users(id) ON DELETE CASCADE | MVP |
| role_id | smallint | NO | | FK → roles(id) RESTRICT | MVP |
| organization_id ★ | uuid | YES | | FK → organizations RESTRICT; required for ORGANIZATION/FACILITY scope | MVP |
| facility_id ★ | uuid | YES | | composite FK (facility_id, organization_id) → facilities; required for FACILITY scope | MVP |
| granted_by ★ | uuid | YES | | FK → users(id) SET NULL | MVP |
| granted_at ★ | timestamptz | NO | now() | | MVP |

- UNIQUE NULLS NOT DISTINCT `(user_id, role_id, organization_id, facility_id)`.
- Trigger: enforce scope — PLATFORM/SELF ⇒ org and facility null; ORGANIZATION ⇒ org set, facility null; FACILITY ⇒ both set, facility type compatible with role (§9).
- Indexes: `(user_id)`, `(facility_id, role_id)`.

### 3.6 blood_groups
Reference data, not hard-coded (Step 3 §7).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | smallint | NO | identity | PK | MVP |
| code | text | NO | | UNIQUE; 'A+','A-','B+','B-','AB+','AB-','O+','O-','UNKNOWN' | MVP |
| display_name ★ | text | NO | | 'O−' with a true minus sign for UI | MVP |
| abo ★ | text | YES | | CHECK in ('A','B','AB','O'); null for UNKNOWN | MVP |
| rhd ★ | text | YES | | CHECK in ('+','-'); null for UNKNOWN | MVP |
| is_known ★ | boolean | NO | | false only for UNKNOWN | MVP |
| sort_order ★ | smallint | NO | | | MVP |

UNKNOWN is allowed on request items and donors, **never** on inventory units (trigger check).

### 3.7 components
Blood product types; configurable (Step 3 §8).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | smallint | NO | identity | PK | MVP |
| code | text | NO | | UNIQUE; MVP set WHOLE_BLOOD, PRBC, PLASMA_FFP, PLATELETS | MVP |
| name | text | NO | | | MVP |
| category | component_category | NO | | | MVP |
| storage_temp_min | numeric(4,1) | YES | | °C; **null until an approved clinical value exists** | MVP |
| storage_temp_max | numeric(4,1) | YES | | CHECK max ≥ min when both set | MVP |
| typical_storage_days | smallint | YES | | shelf life; CHECK > 0 when set; null until approved | MVP |
| values_validation_status ★ | rule_validation_status | NO | 'DEMO_ONLY' | whether the three values above are authoritative | MVP |
| values_source_reference ★ | text | YES | | citation for the values | MVP |
| values_validated_by ★ / values_validated_at ★ | uuid / timestamptz | YES | | clinical approver (FK → users SET NULL) | MVP |
| active | boolean | NO | true | | MVP |

- CHECK `values_validation_status <> 'VALIDATED' OR (values_source_reference IS NOT NULL AND values_validated_by IS NOT NULL AND values_validated_at IS NOT NULL AND typical_storage_days IS NOT NULL)`.
- **No clinical values are seeded (U5).** Components are seeded with code, name and category only. Nothing structurally needs these values: each unit's `expiry_date` is entered from the bag label (§3.9), and `expiry.warning_days` is a planning parameter.

### 3.8 storage_locations
Refrigerators/freezers inside a facility.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| facility_id | uuid | NO | | FK → facilities RESTRICT | MVP |
| name | text | NO | | UNIQUE (facility_id, name) | MVP |
| type | storage_location_type | NO | | | MVP |
| temperature_min | numeric(4,1) | YES | | | MVP |
| temperature_max | numeric(4,1) | YES | | CHECK max ≥ min | MVP |
| capacity | integer | YES | | units; CHECK > 0 | FR |
| status | storage_location_status | NO | 'ACTIVE' | | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- UNIQUE `(id, facility_id)` — target of the composite FK from inventory_units.
- Nested shelves (Step 3 §11 example) deferred (`parent_location_id` later).

### 3.9 inventory_units
One row per physical bag/component — the core of BloodLink (Step 3 §9–10). Detail in §5.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| unit_code | text | NO | | UNIQUE; bag identifier (ISBT-128-style) | MVP |
| facility_id | uuid | NO | | current holder; FK → facilities RESTRICT | MVP |
| donation_id | uuid | YES | | FK → donations RESTRICT; null for procured/imported units | MVP |
| component_id | smallint | NO | | FK → components RESTRICT | MVP |
| blood_group_id | smallint | NO | | FK → blood_groups RESTRICT; must be `is_known` | MVP |
| collection_date | timestamptz | NO | | | MVP |
| processing_date | timestamptz | YES | | CHECK ≥ collection_date | MVP |
| expiry_date | timestamptz | NO | | as labelled on the bag by the blood centre (never computed by BloodLink); CHECK > collection_date | MVP |
| volume_ml | integer | YES | | CHECK > 0 | MVP |
| status | inventory_unit_status | NO | 'QUARANTINED' | new units wait for screening | MVP |
| status_changed_at ★ | timestamptz | NO | now() | | MVP |
| storage_location_id | uuid | YES | | composite FK (storage_location_id, facility_id) → storage_locations(id, facility_id) | MVP |
| reserved_for_request_id | uuid | YES | | FK → requests SET NULL; see risk F6 | MVP |
| received_at | timestamptz | NO | now() | entered this facility | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- CHECK `reserved_for_request_id IS NULL OR status IN ('RESERVED','DISPATCHED')`.
- Trigger: `unit_code, donation_id, component_id, blood_group_id, collection_date` immutable after insert; facility must have `holds_inventory`.
- Indexes:
  - `(facility_id, blood_group_id, component_id, expiry_date) WHERE status = 'AVAILABLE'` — availability + first-expiry-first-out (FEFO) picking
  - `(facility_id, status)` — summaries
  - `(expiry_date) WHERE status IN ('AVAILABLE','RESERVED','QUARANTINED','RECEIVED')` — expiry job
  - `(donation_id)`, `(reserved_for_request_id)`

### 3.10 donors
People who may donate. Minimal personal data; **no medical eligibility decisions** are stored as AI output.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| user_id | uuid | YES | | FK → users(id) SET NULL; UNIQUE | MVP |
| full_name | text | NO | | spec "name" | MVP |
| blood_group_id | smallint | NO | | FK → blood_groups; UNKNOWN allowed | MVP |
| blood_group_verified ★ | boolean | NO | false | true once typed by a blood centre | MVP |
| date_of_birth | date | YES | | spec "DOB" | MVP |
| phone | text | YES | | | MVP |
| email | text | YES | | | MVP |
| city | text | YES | | | MVP |
| latitude | double precision | YES | | approximate (≈1 km precision stored) | MVP |
| longitude | double precision | YES | | approximate | MVP |
| availability_status | donor_availability | NO | 'AVAILABLE' | self-declared | MVP |
| last_donation_date | date | YES | | maintained from donations (risk F9) | MVP |
| total_donations | integer | NO | 0 | CHECK ≥ 0; maintained from donations | MVP |
| status | donor_status | NO | 'ACTIVE' | set by blood centre only | MVP |
| consent_to_contact ★ | boolean | NO | false | activation targets only consenting donors | MVP |
| preferred_facility_id ★ | uuid | YES | | FK → facilities SET NULL | FR |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- CHECK `phone IS NOT NULL OR email IS NOT NULL OR user_id IS NOT NULL`.
- Indexes: `(blood_group_id, status, availability_status) WHERE consent_to_contact`, `(user_id)`.

### 3.11 donations
A collection event. Not the same as a unit: one donation → several components.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| donor_id | uuid | NO | | FK → donors RESTRICT | MVP |
| facility_id | uuid | NO | | collection facility; FK → facilities RESTRICT | MVP |
| donation_type | donation_type | NO | 'WHOLE_BLOOD' | | MVP |
| donation_date | timestamptz | NO | | | MVP |
| volume_ml | integer | YES | | CHECK > 0 | MVP |
| screening_status | screening_status | NO | 'PENDING' | set by blood centre | MVP |
| eligibility_status | eligibility_status | NO | 'PENDING' | set by blood centre | MVP |
| deferral_reason | text | YES | | free text, minimal | MVP |
| activation_recipient_id ★ | uuid | YES | | FK → donor_activation_recipients SET NULL (closes the MOBILIZE loop) | MVP |
| recorded_by ★ | uuid | YES | | FK → users SET NULL | MVP |
| created_at | timestamptz | NO | now() | | MVP |

- CHECK `eligibility_status NOT IN ('TEMPORARILY_DEFERRED','PERMANENTLY_DEFERRED') OR deferral_reason IS NOT NULL`.
- CHECK `volume_ml IS NOT NULL OR eligibility_status <> 'ELIGIBLE'`.
- `camp_id` from Step 3 deferred with `blood_camps` (Tier 3).
- Indexes: `(donor_id, donation_date DESC)`, `(facility_id, donation_date)`.

### 3.12 donation_components
Links a donation to what was produced (including components discarded before becoming units).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| donation_id | uuid | NO | | FK → donations ON DELETE CASCADE | MVP |
| component_id | smallint | NO | | FK → components RESTRICT | MVP |
| inventory_unit_id | uuid | YES | | FK → inventory_units RESTRICT; UNIQUE | MVP |
| processing_date | timestamptz | YES | | | MVP |
| processing_status | processing_status | NO | 'PENDING' | | MVP |

- UNIQUE `(donation_id, component_id)`.
- CHECK `processing_status <> 'PROCESSED' OR inventory_unit_id IS NOT NULL`.

### 3.13 requests
Any request for blood: hospital routine/bulk, facility emergency, or public emergency.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| request_number ★ | text | NO | generated | UNIQUE, human-readable 'REQ-2026-000123' (sequence) | MVP |
| requester_user_id | uuid | NO | | FK → users RESTRICT | MVP |
| requester_facility_id | uuid | YES | | FK → facilities RESTRICT; null for public requesters | MVP |
| patient_facility_id ★ | uuid | NO | | where the patient is treated / blood is delivered; FK → facilities RESTRICT | MVP |
| verifying_facility_id ★ | uuid | NO | | facility whose staff verify; defaults to patient facility | MVP |
| request_type | request_type | NO | | | MVP |
| urgency | urgency_level | NO | 'NORMAL' | | MVP |
| required_by | timestamptz | NO | | | MVP |
| patient_reference | text | YES | | case/reference number only — **no patient name** | MVP |
| contact_phone ★ | text | YES | | required for public requests (CHECK via trigger on requester role) | MVP |
| verification_status | verification_status | NO | 'PENDING_VERIFICATION' | | MVP |
| verification_method ★ | verification_method | YES | | STAFF_AT_CREATION when an authorized staff creator self-verifies; STAFF_REVIEW otherwise | MVP |
| verified_by ★ | uuid | YES | | FK → users SET NULL | MVP |
| verified_at ★ | timestamptz | YES | | | MVP |
| verification_note ★ | text | YES | | required when REJECTED | MVP |
| status | request_status | NO | 'OPEN' | | MVP |
| notes | text | YES | | | MVP |
| cancelled_at / fulfilled_at ★ | timestamptz | YES | | | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- CHECK `status NOT IN ('ALLOCATED','PARTIALLY_FULFILLED','FULFILLED') OR verification_status = 'VERIFIED'` — **an unverified request can never reach allocation or fulfilment** (public-requester safety).
- CHECK `verification_status = 'PENDING_VERIFICATION' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND verification_method IS NOT NULL)`.
- Trigger: `verification_method = 'STAFF_AT_CREATION'` only if `verified_by = requester_user_id` **and** that user holds HOSPITAL_STAFF, DOCTOR or EMERGENCY_STAFF at `requester_facility_id` **and** the facility's organization is VERIFIED or ACTIVE. A PUBLIC_REQUESTER can never self-verify.
- CHECK `verification_status <> 'REJECTED' OR verification_note IS NOT NULL`.
- Indexes: `(verifying_facility_id, verification_status)`, `(patient_facility_id, status)`, `(requester_user_id, created_at DESC)`, `(status, required_by) WHERE status IN ('OPEN','ALLOCATED','PARTIALLY_FULFILLED')`.

### 3.14 request_items
One product line inside a request (e.g. O− PRBC × 2).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| request_id | uuid | NO | | FK → requests ON DELETE CASCADE | MVP |
| blood_group_id | smallint | NO | | recipient group; FK → blood_groups (UNKNOWN allowed) | MVP |
| component_id | smallint | NO | | FK → components | MVP |
| quantity_requested | smallint | NO | | CHECK 1..100 | MVP |
| quantity_fulfilled | smallint | NO | 0 | CHECK 0 ≤ fulfilled ≤ requested; = count of ISSUED allocations | MVP |
| urgency | urgency_level | YES | | overrides request urgency when set | MVP |
| required_by | timestamptz | YES | | overrides request deadline | MVP |
| allow_compatible_substitutes ★ | boolean | NO | true | clinician may insist on identical group only | MVP |

- UNIQUE `(request_id, blood_group_id, component_id)`.
- Index: `(blood_group_id, component_id)`.

### 3.15 request_allocations
Ties one physical unit to one request item. Full traceability request → bag.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| request_item_id | uuid | NO | | FK → request_items RESTRICT | MVP |
| inventory_unit_id | uuid | NO | | FK → inventory_units RESTRICT | MVP |
| source_facility_id ★ | uuid | NO | | facility holding the unit at allocation time (units move, this does not) | MVP |
| recommendation_id ★ | uuid | YES | | FK → recommendations SET NULL (EMERGENCY_SOURCE that led here) | MVP |
| status | allocation_status ★ | NO | 'RESERVED' | | MVP |
| allocated_at | timestamptz | NO | now() | | MVP |
| allocated_by | uuid | NO | | FK → users RESTRICT — the person who **requested** the allocation (selected the source); never the AI. The reservation itself is executed by the source-context function (§6.5) | MVP |
| hold_expires_at ★ | timestamptz | YES | | end of the temporary hold = created + source's `allocation.hold_timeout_minutes`; required while RESERVED | MVP |
| confirmed_by / confirmed_at ★ | uuid / timestamptz | YES | | source blood-centre authorization | MVP |
| dispatched_at / issued_at ★ | timestamptz | YES | | | MVP |
| cancelled_at ★ / cancel_reason ★ | timestamptz / text | YES | | also set for EXPIRED (reason `CONFIRMATION_TIMEOUT`) and source DECLINED | MVP |

- UNIQUE `(inventory_unit_id) WHERE status IN ('RESERVED','CONFIRMED','DISPATCHED')` — a unit can be actively allocated only once.
- CHECK `status IN ('RESERVED','CANCELLED','EXPIRED') OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)` — **no dispatch, issue or return without source confirmation**.
- CHECK `status <> 'RESERVED' OR hold_expires_at IS NOT NULL`; CHECK `status NOT IN ('CANCELLED','EXPIRED') OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)`.
- Rows are created and changed **only** by the functions in §6.5; direct INSERT/UPDATE is rejected by trigger (same pattern as unit status).
- Trigger: parent request must be VERIFIED; unit must be at `source_facility_id`; unit's group/component must satisfy `compatibility_rules` for the item (§5.4).
- Index: `(hold_expires_at) WHERE status = 'RESERVED'` — timeout release job.
- Indexes: `(request_item_id)`, `(source_facility_id, status)`.

### 3.16 transfers
Redistribution between two facilities (possibly two organizations). Single product line per transfer (assumption C6).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| transfer_number ★ | text | NO | generated | UNIQUE 'TRF-2026-000045' | MVP |
| source_facility_id | uuid | NO | | FK → facilities RESTRICT | MVP |
| destination_facility_id | uuid | NO | | FK → facilities RESTRICT; CHECK ≠ source | MVP |
| blood_group_id ★ | smallint | NO | | FK → blood_groups | MVP |
| component_id ★ | smallint | NO | | FK → components | MVP |
| requested_quantity ★ | smallint | NO | | CHECK > 0 | MVP |
| approved_quantity ★ | smallint | YES | | CHECK 0 < approved ≤ requested; set on APPROVED | MVP |
| recommendation_id ★ | uuid | YES | | FK → recommendations SET NULL | MVP |
| status | transfer_status | NO | 'PROPOSED' | | MVP |
| reason | text | YES | | | MVP |
| initiated_by | uuid | NO | | FK → users RESTRICT (destination side) | MVP |
| approved_by | uuid | YES | | FK → users RESTRICT (source side) | MVP |
| rejected_by ★ / rejection_reason ★ | uuid / text | YES | | | MVP |
| dispatched_by ★ / received_by ★ | uuid | YES | | FK → users RESTRICT | MVP |
| requested_at | timestamptz | NO | now() | | MVP |
| approved_at ★ | timestamptz | YES | | | MVP |
| dispatched_at | timestamptz | YES | | | MVP |
| received_at | timestamptz | YES | | | MVP |
| cancelled_at ★ | timestamptz | YES | | | MVP |
| estimated_transit_minutes ★ | integer | YES | | from Maps adapter at proposal | MVP |
| updated_at ★ | timestamptz | NO | now() | | MVP |

- CHECKs pairing status with its evidence: APPROVED ⇒ approved_by/approved_at/approved_quantity set; IN_TRANSIT ⇒ dispatched_by/at set; RECEIVED ⇒ received_by/at set; REJECTED ⇒ rejected_by and rejection_reason set.
- **Planned quantity is kept on the transfer (decision D5 condition).** `requested_quantity` exists from PROPOSED, before any unit is chosen; `approved_quantity` is set by the source. Units (`transfer_items`) are assigned only at/after approval. Trigger: item count ≤ approved_quantity while APPROVED, and = approved_quantity at dispatch (a shortfall must be resolved by lowering approved_quantity, which is audited). Dispatched and received counts are derived from `transfer_items` (`accepted`).
- Indexes: `(source_facility_id, status)`, `(destination_facility_id, status)`, `(status) WHERE status IN ('PROPOSED','APPROVED','IN_TRANSIT')`.

### 3.17 transfer_items
The specific units picked for a transfer.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| transfer_id | uuid | NO | | FK → transfers ON DELETE CASCADE | MVP |
| inventory_unit_id | uuid | NO | | FK → inventory_units RESTRICT | MVP |
| accepted ★ | boolean | YES | | set at receipt; false = rejected on arrival (goes QUARANTINED) | MVP |
| created_at ★ | timestamptz | NO | now() | | MVP |

- UNIQUE `(transfer_id, inventory_unit_id)`.
- Step 3's `component_id` and `quantity` are **not** kept: with one row per unit, quantity is always 1 and component is the unit's own (explained in conflict D5).
- Trigger: unit group/component must equal the transfer's; unit must be at the source facility; number of items ≤ approved_quantity.

### 3.18 predictions
Stored output of the AI service with its full context (Step 3 §20). Detail in §7.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| run_id ★ | uuid | NO | | groups rows from one recalculation | MVP |
| organization_id ★ | uuid | NO | | composite FK (facility_id, organization_id) → facilities | MVP |
| facility_id | uuid | NO | | | MVP |
| blood_group_id | smallint | NO | | | MVP |
| component_id | smallint | NO | | | MVP |
| prediction_type | prediction_type | NO | | | MVP |
| horizon_days ★ | smallint | NO | | spec "prediction_horizon"; CHECK 1..90 | MVP |
| period_start ★ / period_end ★ | date | NO | | forecast window; CHECK end ≥ start | MVP |
| predicted_daily_demand ★ | numeric(8,3) | YES | | units/day | MVP |
| predicted_quantity | numeric(10,3) | YES | | total demand over horizon | MVP |
| usable_units ★ | integer | YES | | AVAILABLE, unexpired, at calculation time | MVP |
| reserved_units ★ | integer | YES | | | MVP |
| pending_request_units ★ | integer | YES | | verified, unallocated demand | MVP |
| incoming_units ★ | integer | YES | | in-transit to facility + quarantined | MVP |
| expiring_units ★ | integer | YES | | expiring within horizon (EXPIRY type) | MVP |
| at_risk_units ★ | integer | YES | | expected to expire before use (EXPIRY type) | MVP |
| days_of_cover ★ | numeric(6,2) | YES | | | MVP |
| predicted_shortage_date | date | YES | | | MVP |
| shortage_risk ★ | risk_level | YES | | | MVP |
| confidence_score | numeric(4,3) | YES | | CHECK 0..1; **only if the model computes one** | MVP |
| confidence_method ★ | text | YES | | e.g. 'backtest_mape_28d'; required when score is set | MVP |
| explanation | jsonb | NO | '{}' | structured WHY + inputs (not only text) | MVP |
| model_name ★ | text | NO | | e.g. 'moving_average_weekday' | MVP |
| model_version | text | NO | | | MVP |
| generated_at | timestamptz | NO | now() | | MVP |
| superseded_at ★ | timestamptz | YES | | set when a newer run replaces this row | MVP |

- CHECK `(confidence_score IS NULL) = (confidence_method IS NULL)` — no confidence without a stated method.
- UNIQUE `(facility_id, blood_group_id, component_id, prediction_type, horizon_days) WHERE superseded_at IS NULL` — one current prediction per series.
- Indexes: `(organization_id, generated_at DESC)`, `(run_id)`.
- Step 3's `recommended_quantity` and `recommendation_type` are **not** on predictions — they live in `recommendations` (D3 approved).

### 3.19 alerts
Organization-facing notices generated by predictions or events.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| organization_id | uuid | NO | | FK → organizations RESTRICT | MVP |
| facility_id | uuid | YES | | composite FK with organization | MVP |
| alert_type | alert_type | NO | | | MVP |
| severity | risk_level | NO | | | MVP |
| title | text | NO | | | MVP |
| message | text | NO | | | MVP |
| source_prediction_id | uuid | YES | | FK → predictions SET NULL | MVP |
| recommendation_id ★ | uuid | YES | | FK → recommendations SET NULL | MVP |
| request_id ★ / transfer_id ★ | uuid | YES | | FK SET NULL | MVP |
| dedupe_key ★ | text | YES | | prevents repeating the same open alert every recalculation | MVP |
| status | alert_status | NO | 'UNREAD' | organization-level state (per-user read state deferred) | MVP |
| acknowledged_by ★ / acknowledged_at ★ | uuid / timestamptz | YES | | | MVP |
| resolved_by ★ / resolved_at | uuid / timestamptz | YES | | | MVP |
| created_at | timestamptz | NO | now() | | MVP |

- UNIQUE `(organization_id, dedupe_key) WHERE status <> 'RESOLVED'`.
- Index: `(organization_id, status, created_at DESC)`.

### 3.20 donor_activations
A targeted call for donors when stock + redistribution + incoming supply are insufficient (workflow 6).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| organization_id ★ | uuid | NO | | composite FK (facility_id, organization_id) | MVP |
| facility_id | uuid | NO | | blood centre donors should visit | MVP |
| prediction_id | uuid | YES | | FK → predictions SET NULL | MVP |
| recommendation_id ★ | uuid | YES | | FK → recommendations SET NULL | MVP |
| blood_group_id | smallint | NO | | | MVP |
| component_id | smallint | NO | | | MVP |
| units_needed | smallint | NO | | CHECK > 0 | MVP |
| target_donor_count | smallint | NO | | CHECK > 0 | MVP |
| urgency ★ | urgency_level | NO | 'HIGH' | | MVP |
| radius_km ★ | numeric(5,1) | NO | | search area around the facility | MVP |
| donor_message ★ | text | NO | | what donors see; no clinical claims | MVP |
| status | donor_activation_status ★ | NO | 'ACTIVE' | | MVP |
| activated_by ★ | uuid | NO | | FK → users RESTRICT (a person approves) | MVP |
| expires_at ★ | timestamptz | NO | | | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- Index: `(organization_id, status)`, `(blood_group_id, status)`.

### 3.21 donor_activation_recipients
Each donor contacted by an activation and how they responded.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id ★ | uuid | NO | uuid() | PK | MVP |
| activation_id | uuid | NO | | FK → donor_activations ON DELETE CASCADE | MVP |
| donor_id | uuid | NO | | FK → donors RESTRICT | MVP |
| distance_km ★ | numeric(5,1) | NO | | snapshot at targeting time | MVP |
| notification_status | notification_status | NO | 'PENDING' | | MVP |
| notified_at ★ | timestamptz | YES | | | MVP |
| response | donor_response ★ | NO | 'NO_RESPONSE' | spec field; enum values new | MVP |
| responded_at | timestamptz | YES | | | MVP |
| created_at ★ | timestamptz | NO | now() | | MVP |

- UNIQUE `(activation_id, donor_id)`.
- Outcome (donated or deferred) is recorded on `donations.activation_recipient_id` by the blood centre — not here, and never by AI.
- Index: `(donor_id, created_at DESC)`.

### 3.22 recommendations
AI recommendations that need a human decision (decision F). Detail in §7.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| recommendation_type | recommendation_type | NO | | | MVP |
| organization_id | uuid | NO | | the organization that must decide | MVP |
| facility_id | uuid | YES | | composite FK with organization | MVP |
| related_prediction_id | uuid | YES | | FK → predictions SET NULL | MVP |
| related_request_id ★ | uuid | YES | | FK → requests SET NULL (EMERGENCY_SOURCE) | MVP |
| status | recommendation_status | NO | 'PENDING' | | MVP |
| priority ★ | risk_level | NO | | | MVP |
| payload | jsonb | NO | | machine-readable proposal (schema per type, §7.3) | MVP |
| modified_payload ★ | jsonb | YES | | human-edited version when MODIFIED | MVP |
| what_explanation | text | NO | | | MVP |
| why_explanation | text | NO | | | MVP |
| data_explanation | jsonb | NO | | array of {label, value, unit} — structured so the UI renders the DATA list | MVP |
| action_explanation | text | NO | | | MVP |
| source | recommendation_source | NO | 'AI_SERVICE' | "recommended_by / source" | MVP |
| model_version ★ | text | YES | | | MVP |
| dedupe_key ★ | text | NO | | e.g. 'REDISTRIBUTION:O-:PRBC:<src>→<dst>' | MVP |
| valid_until ★ | timestamptz | NO | | after this it becomes EXPIRED | MVP |
| decided_by | uuid | YES | | FK → users RESTRICT | MVP |
| decided_at | timestamptz | YES | | | MVP |
| decision_note ★ | text | YES | | required for REJECTED and MODIFIED | MVP |
| executed_at ★ | timestamptz | YES | | | MVP |
| created_at / updated_at | timestamptz | NO | now() | | MVP |

- CHECK `status IN ('PENDING','EXPIRED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)`.
- CHECK `status <> 'MODIFIED' OR modified_payload IS NOT NULL`; CHECK `status NOT IN ('MODIFIED','REJECTED') OR decision_note IS NOT NULL`.
- CHECK `status <> 'EXECUTED' OR executed_at IS NOT NULL`.
- UNIQUE `(organization_id, dedupe_key) WHERE status = 'PENDING'`.
- Indexes: `(organization_id, status, priority)`, `(related_prediction_id)`.

### 3.23 transactions
Append-only ledger of inventory events per unit — the AI's main history source (Step 3 §23, §29). Detail in §11.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| transaction_type | transaction_type | NO | | | MVP |
| occurred_at | timestamptz | NO | now() | | MVP |
| facility_id ★ | uuid | NO | | where it happened | MVP |
| counterpart_facility_id ★ | uuid | YES | | other side of a transfer | MVP |
| inventory_unit_id ★ | uuid | NO | | FK → inventory_units RESTRICT — every ledger row is about exactly one unit | MVP |
| blood_group_id ★ / component_id ★ | smallint | NO | | copied from the unit (immutable fields) for fast demand aggregation | MVP |
| from_status ★ / to_status ★ | inventory_unit_status | YES | | the state change this event caused | MVP |
| request_allocation_id ★ | uuid | YES | | FK SET NULL | MVP |
| transfer_id ★ | uuid | YES | | FK SET NULL | MVP |
| recorded_by ★ | uuid | YES | | FK → users SET NULL; null only for system jobs (expiry) | MVP |
| note ★ | text | YES | | | MVP |

- CHECK `from_status IS DISTINCT FROM to_status`; `to_status` NOT NULL; `from_status` null only for creation events (COMPONENT_CREATED, INVENTORY_ADDED, PROCUREMENT_RECEIVED).
- Rows are inserted only by `transition_unit_status()` / the unit-creation function (§11.1).
- No UPDATE/DELETE: enforced by trigger (append-only).
- Indexes: `(facility_id, transaction_type, occurred_at)`, `(inventory_unit_id, occurred_at)`, `(facility_id, blood_group_id, component_id, occurred_at) WHERE transaction_type = 'INVENTORY_ISSUED'` (demand history).

### 3.24 audit_logs
Security audit: who did what (Step 3 §24). Separate from transactions. Detail in §11.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| occurred_at | timestamptz | NO | now() | spec "timestamp" | MVP |
| user_id | uuid | YES | | actor; plain uuid (no FK) so history survives | MVP |
| organization_id | uuid | YES | | no FK, same reason | MVP |
| facility_id ★ | uuid | YES | | | MVP |
| action | text | NO | | dotted verb, e.g. 'transfer.approve' | MVP |
| entity_type | text | NO | | e.g. 'transfer' | MVP |
| entity_id | uuid | YES | | | MVP |
| old_value | jsonb | YES | | changed, non-sensitive fields only | MVP |
| new_value | jsonb | YES | | | MVP |
| ip_address | inet | YES | | | MVP |
| correlation_id ★ | uuid | YES | | ties an audit row to the API request / DB transaction | MVP |

- Append-only (trigger). Indexes: `(organization_id, occurred_at DESC)`, `(entity_type, entity_id)`, `(user_id, occurred_at DESC)`.

### 3.25 compatibility_rules
Configurable, clinically validated donor→recipient compatibility per component. **AI never writes or infers these.** Detail in §5.4.

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | smallint | NO | identity | PK | MVP |
| donor_blood_group_id | smallint | NO | | FK → blood_groups RESTRICT; must be `is_known` | MVP |
| recipient_blood_group_id | smallint | NO | | FK → blood_groups RESTRICT; UNKNOWN allowed | MVP |
| component_id | smallint | NO | | FK → components RESTRICT | MVP |
| compatible | boolean | NO | | explicit false rows allowed; missing row = not compatible | MVP |
| priority | smallint | NO | | 1 = preferred (identical), higher = acceptable alternative; CHECK > 0 | MVP |
| validation_status ★ | rule_validation_status | NO | 'DEMO_ONLY' | only VALIDATED rules are authoritative | MVP |
| source_reference ★ | text | YES | | citation: document, edition/version, section/table — required for VALIDATED | MVP |
| source_url ★ | text | YES | | link to the reference where available | MVP |
| validated_by ★ | uuid | YES | | FK → users SET NULL — the clinical approver | MVP |
| validated_at ★ | timestamptz | YES | | | MVP |
| validation_note ★ | text | YES | | approver's remarks | MVP |
| notes | text | YES | | | MVP |
| created_at / updated_at ★ | timestamptz | NO | now() | | MVP |

- UNIQUE `(donor_blood_group_id, recipient_blood_group_id, component_id) WHERE validation_status <> 'RETIRED'` (old versions are retired, never overwritten).
- CHECK `validation_status <> 'VALIDATED' OR (source_reference IS NOT NULL AND validated_by IS NOT NULL AND validated_at IS NOT NULL)`.
- Supports all four MVP components (PRBC, WHOLE_BLOOD, PLASMA_FFP, PLATELETS) and recipient UNKNOWN structurally; **which rows exist is a clinical decision** (§5.4, §20 U2).
- Matching uses VALIDATED rules; DEMO_ONLY rules are used only when the backend runs with `ALLOW_DEMO_COMPATIBILITY_RULES=true` (never in production), and the UI then shows a "compatibility rules not clinically validated" notice.
- Writes: SUPER_ADMIN via backend; setting VALIDATED records the approver; every change audited.

### 3.26 ★ planning_parameters — additional table (APPROVED, decision 1)
**Why necessary:** decision A requires every threshold, weight, reserve floor and ETA assumption to be
reviewable and not hard-coded. These numbers (target days of cover, reserve floor, scoring weights,
donor search radius, ETA speed) directly change the demo outcome (§12). Keeping them in a table
makes them visible, auditable, overridable per facility, and readable by both the backend and the AI
service. *Alternative if you prefer no new table:* a versioned JSON config file in `ai-service/`
(simpler, but not editable at runtime and not per-facility).

| Column | Type | Null | Default | Key / notes | Tier |
|---|---|---|---|---|---|
| id | uuid | NO | uuid() | PK | MVP |
| key | text | NO | | e.g. 'coverage.target_days', 'reserve.floor_days', 'eta.urban_speed_kmh' | MVP |
| organization_id | uuid | YES | | null = network default | MVP |
| facility_id | uuid | YES | | composite FK (facility_id, organization_id) → facilities | MVP |
| blood_group_id | smallint | YES | | FK → blood_groups; null = all groups | MVP |
| component_id | smallint | YES | | FK → components; null = all components | MVP |
| value | jsonb | NO | | CHECK `jsonb_typeof(value) IN ('number','object')`; type per key validated by the backend's parameter registry | MVP |
| description | text | NO | | what it controls | MVP |
| updated_by | uuid | YES | | FK → users SET NULL | MVP |
| updated_at | timestamptz | NO | now() | | MVP |

- UNIQUE NULLS NOT DISTINCT `(key, organization_id, facility_id, blood_group_id, component_id)`.
- CHECK `facility_id IS NULL OR organization_id IS NOT NULL`.
- **Resolution (most specific wins)**, implemented once in SQL (`private.resolve_parameter(key, facility, group, component)`):
  facility+group+component → facility+group → facility+component → facility → organization+group+component → organization → network default (all scope columns null). A missing key with no default is an error, never a silent constant.
- **The AI service holds no values.** The backend resolves every parameter for the series being calculated and sends them in the request to FastAPI; the AI echoes them back into `predictions.explanation` / `recommendations.data_explanation`, so every output records the exact parameters used.
- Writes: SUPER_ADMIN (network defaults), ORG_ADMIN or BLOOD_BANK_ADMIN (own organization / facility); every change audited with old and new value.
- Initial key catalog (values are decided in Phase 6 and seeded as rows, not code):

  | Key | Typical scope | Meaning |
  |---|---|---|
  | coverage.target_days | facility + group + component | days of cover a facility aims to hold; drives transfer and procurement quantities |
  | coverage.risk_bands | facility + component | thresholds mapping days of cover → CRITICAL / HIGH / MEDIUM / LOW |
  | reserve.floor_days | facility + group + component | cover a *source* must keep after giving units away |
  | transfer.min_units / transfer.max_units | facility + component | smallest worthwhile and largest single transfer |
  | allocation.hold_timeout_minutes | source facility | how long a temporary hold waits for source confirmation (§6.5); if missing, the source cannot accept holds (explicit error, no default) |
  | expiry.warning_days | component | window for 'expiring soon' |
  | forecast.history_days, forecast.horizon_days | network / facility | forecasting window |
  | eta.road_factor, eta.urban_speed_kmh | network | mock Maps adapter ETA |
  | ranking.weights | network | emergency source scoring weights |
  | donor.search_radius_km, donor.min_interval_days | facility | donor activation targeting (not eligibility) |

---

## 4. Relationships

### Map

```text
auth.users 1──1 users N──N roles            (via user_roles, optionally scoped to a facility)
                  │
organizations 1──N facilities 1──N storage_locations
      │               │
      │               ├──1──N inventory_units N──1 blood_groups / components
      │               │            │  └─N──1 donations N──1 donors 1──0..1 users
      │               │            │         └─1──N donation_components ──0..1 inventory_units
      │               │            ├─1──N request_allocations N──1 request_items N──1 requests
      │               │            ├─1──N transfer_items N──1 transfers (source + destination facility)
      │               │            └─1──N transactions
      │               ├──1──N requests (as patient / verifying / requester facility)
      │               ├──1──N predictions ──0..N alerts
      │               │            └──0..N recommendations ──0..N transfers / allocations / donor_activations
      │               └──1──N donor_activations 1──N donor_activation_recipients N──1 donors
      └──1──N alerts, recommendations, audit_logs (by organization_id)
compatibility_rules N──1 blood_groups (donor), N──1 blood_groups (recipient), N──1 components
```

### Cardinality

| Relationship | Cardinality | Notes |
|---|---|---|
| Organization → Facilities | 1 → 1..N | Hospital+Blood Centre = 1 org with ≥1 HOSPITAL and ≥1 BLOOD_CENTRE facility |
| Organization → Users | 1 → 0..N | platform/self users have no organization |
| User ↔ Role | N ↔ N | via user_roles; a grant may be scoped to one facility |
| Facility → Storage locations | 1 → 0..N | |
| Facility → Inventory units | 1 → 0..N | only `holds_inventory` facilities |
| Donor → Donations | 1 → 0..N | |
| Donation → Donation components | 1 → 1..N | |
| Donation component → Inventory unit | 1 → 0..1 | discarded components have no unit |
| Request → Request items | 1 → 1..N | |
| Request item → Allocations | 1 → 0..N | one allocation per unit |
| Inventory unit → Allocations | 1 → 0..N over time, **max 1 active** | partial unique index |
| Transfer → Transfer items | 1 → 0..N (≤ approved_quantity) | |
| Inventory unit → Transfer items | 1 → 0..N over time | a unit can be moved more than once |
| Facility → Predictions | 1 → 0..N | one *current* row per series |
| Prediction → Alerts | 1 → 0..N | |
| Prediction → Recommendations | 1 → 0..N | |
| Recommendation → Transfer / Allocations / Donor activation | 1 → 0..1 / 0..N / 0..1 | child rows point back via `recommendation_id` |
| Donor activation → Recipients | 1 → 0..N | |
| Recipient → Donation | 1 → 0..1 | recorded by the blood centre |
| Inventory unit → Transactions | 1 → 1..N | full lifecycle |

---

## 5. Inventory model

### 5.1 One row per bag
Aggregate numbers are never stored. Every figure on the dashboards is a query over `inventory_units`,
so "O− PRBC at Centre A" is always consistent with the units behind it.

### 5.2 Status lifecycle (the 10 approved statuses, unchanged)

| Status | Meaning | Counts as usable stock? |
|---|---|---|
| QUARANTINED | Collected/received, awaiting screening or acceptance; also units rejected on arrival | No — counted as **incoming** |
| AVAILABLE | Screened, in storage, free to allocate | **Yes** (if not expired) |
| RESERVED | Held for a request allocation or an approved transfer | No |
| DISPATCHED | Released to a requester outside the network, on its way to the patient's facility | No |
| IN_TRANSIT | Moving between two BloodLink facilities under a transfer | No at source; **incoming** at destination |
| RECEIVED | Arrived at destination, awaiting acceptance check | No — incoming |
| ISSUED | Handed over for patient use (terminal for demand history) | No |
| RETURNED | Came back unused from a ward or requester; needs inspection | No |
| WASTED | Discarded (breakage, cold-chain failure, failed test) — terminal | No |
| EXPIRED | Passed expiry date — terminal | No |

`DISPATCHED` vs `IN_TRANSIT` are kept distinct on purpose: DISPATCHED leaves the network for a patient
(request fulfilment), IN_TRANSIT stays in the network (transfer). `RECEIVED` is the short state between
arrival and acceptance; in the MVP, receipt may accept immediately (RECEIVED → AVAILABLE in the same
operation) while still recording both events.

Allowed transitions and the ledger event each one writes are defined once, in the canonical table in
§11.1. Status changes happen only through `transition_unit_status()`.

### 5.3 Aggregates (view `v_inventory_summary`)

```sql
-- per facility × blood group × component, computed on read
SELECT facility_id, blood_group_id, component_id,
  count(*) FILTER (WHERE status NOT IN ('ISSUED','WASTED','EXPIRED','DISPATCHED'))    AS on_hand,
  count(*) FILTER (WHERE status = 'AVAILABLE' AND expiry_date > now())                 AS usable,
  count(*) FILTER (WHERE status = 'RESERVED')                                          AS reserved,
  count(*) FILTER (WHERE status IN ('QUARANTINED','RECEIVED'))                         AS pending_acceptance,
  count(*) FILTER (WHERE status = 'AVAILABLE'
                     AND expiry_date <= now() + interval '7 days')                     AS expiring_7d
FROM inventory_units GROUP BY 1,2,3;
```

- **Incoming** for facility F = units IN_TRANSIT on transfers whose destination is F + F's QUARANTINED/RECEIVED units.
- **Pending demand** = Σ(quantity_requested − quantity_fulfilled − active allocations) over VERIFIED, non-closed request items whose `patient_facility_id` is served by F.
- The expiry job (scheduled) moves past-expiry units to EXPIRED, but `usable` also filters on `expiry_date`, so a late job can never overstate stock.
- Performance: served by the partial `AVAILABLE` index; volumes in the MVP (thousands of units) need no materialized view. Realtime clients subscribe to `inventory_units` changes for their facility and re-query the view.

### 5.4 Compatibility (emergency fulfilment)

Emergency matching filters **only** through validated rules. No rule row → not compatible.

```sql
SELECT u.facility_id, r.priority, count(*) AS units, min(u.expiry_date) AS first_expiry
FROM inventory_units u
JOIN compatibility_rules r
  ON r.donor_blood_group_id = u.blood_group_id
 AND r.component_id        = u.component_id
WHERE r.recipient_blood_group_id = :recipient_group
  AND r.component_id = :component
  AND r.compatible
  AND (r.validation_status = 'VALIDATED'
       OR (r.validation_status = 'DEMO_ONLY' AND :allow_demo_rules))
  AND (:allow_substitutes OR r.donor_blood_group_id = r.recipient_blood_group_id)
  AND u.status = 'AVAILABLE' AND u.expiry_date > :required_by
GROUP BY u.facility_id, r.priority;
```

1. Backend runs this with its privileged connection (network-wide, only for organizations with `shares_network_availability`) and keeps only per-facility counts → candidate facilities. No unit IDs, expiry dates or storage details leave the backend for other organizations (decision 3).
2. Maps adapter adds distance/ETA → AI service ranks the feasible candidates (compatibility is already a hard filter; the AI cannot add a source that failed it).
3. Result stored as an `EMERGENCY_SOURCE` recommendation.
4. An authorized person at the requesting side selects the source → the backend calls the source-context function `private.place_source_hold(...)` (§6.5), which atomically reserves eligible units at the source, first-expiry-first. The requesting organization never writes the source's inventory.

**Seed rules (decision 4 — no invented clinical rules):**
- Development/test data only: **identical-group PRBC rows** (8 rows: O−→O−, O+→O+, … AB+→AB+), `validation_status = 'DEMO_ONLY'`, `source_reference` null, `validation_note = 'Development/testing only — not clinically validated'`. They are the minimum the O− PRBC emergency demo needs and make **no clinical claim**. No row is VALIDATED until an authoritative reference and an approver are in place (U2, production blocker — not a schema blocker).
- **Not seeded:** any cross-group red-cell rule, all WHOLE_BLOOD, PLASMA_FFP and PLATELETS rules, and any rule for recipient UNKNOWN. With no rows, those requests find no compatible source and the backend returns "No validated compatibility rule — contact the blood centre" rather than guessing.
- When a clinical approver provides a validated table (with reference), it is loaded as VALIDATED rows through an audited admin import; DEMO_ONLY rows are then RETIRED.

---

## 6. Request & transfer model

### 6.1 Request types

| Case | requester_user_id | requester_facility_id | patient_facility_id | verifying_facility_id | request_type | initial verification |
|---|---|---|---|---|---|---|
| Hospital routine / bulk | HOSPITAL_STAFF / DOCTOR | ABC Hospital | ABC Hospital | ABC Hospital | ROUTINE / BULK | VERIFIED at creation (`STAFF_AT_CREATION`) |
| Facility emergency (clinic, ambulance) | EMERGENCY_STAFF / DOCTOR | Sunrise Clinic | Sunrise Clinic | Sunrise Clinic | EMERGENCY | VERIFIED at creation (`STAFF_AT_CREATION`) — decision 2 |
| Public emergency (patient / attendant) | PUBLIC_REQUESTER | null | treating hospital | treating hospital | EMERGENCY | PENDING_VERIFICATION (always) |

Blood group, component, quantity and per-item urgency/deadline live on `request_items`; urgency,
required-by, patient reference and verification on `requests`; units on `request_allocations`.

Self-verification at creation requires all three: the creator holds HOSPITAL_STAFF, DOCTOR or EMERGENCY_STAFF at the requesting facility; that facility's organization is VERIFIED/ACTIVE; the creator is not acting as PUBLIC_REQUESTER. Otherwise the request starts PENDING_VERIFICATION and a *different* authorized user at the verifying facility reviews it (`STAFF_REVIEW`).

### 6.2 Why a public requester can never release, allocate, dispatch or order blood
1. **DB CHECK:** a request cannot reach ALLOCATED / PARTIALLY_FULFILLED / FULFILLED unless `verification_status = 'VERIFIED'`.
2. **DB functions:** allocations are created only by `private.place_source_hold`, which requires a VERIFIED request and an actor holding HOSPITAL_STAFF, DOCTOR or EMERGENCY_STAFF at the requesting/patient facility (or blood-bank staff of the source for internal requests). A PUBLIC_REQUESTER is rejected.
3. **Confirmation gate:** allocation → DISPATCHED/ISSUED requires `confirmed_by`, a BLOOD_BANK_ADMIN/STAFF of the source facility.
4. **Backend (authoritative):** PUBLIC_REQUESTER endpoints allow create, cancel-own and read-own only; allocation, confirmation, dispatch, issue, transfer and recommendation endpoints reject any caller without a staff grant at the relevant facility — regardless of what the frontend shows.
5. **RLS:** public requesters can read only their own `requests` / `request_items`; they cannot read `request_allocations` or any inventory table, and have no write policies at all. Their tracking view (status, and the source facility name once confirmed) is served by the backend.

### 6.3 Request status flow

```text
verification:  PENDING_VERIFICATION ──staff──▶ VERIFIED | REJECTED
status:        OPEN ─units reserved▶ ALLOCATED ─some issued▶ PARTIALLY_FULFILLED ─all issued▶ FULFILLED
               OPEN|ALLOCATED ─▶ CANCELLED (units released)      OPEN ─deadline passed▶ EXPIRED
               (REJECTED verification ⇒ status REJECTED)
```

### 6.4 Transfer flow and responsibility

| Step | Status | Who | Unit effect | Recorded |
|---|---|---|---|---|
| Destination approves a REDISTRIBUTION recommendation, or requests manually | PROPOSED | destination BLOOD_BANK_ADMIN / INVENTORY_MANAGER / ORG_ADMIN (`initiated_by`) | — | audit |
| Source approves (may lower `approved_quantity`) | APPROVED | source BLOOD_BANK_ADMIN (`approved_by`) | picked units AVAILABLE → RESERVED (first-expiry-first) | transactions INVENTORY_RESERVED ×n, audit |
| Source rejects | REJECTED | source admin (`rejected_by`, reason) | — | audit |
| Dispatch | IN_TRANSIT | source staff (`dispatched_by`) | RESERVED → IN_TRANSIT | TRANSFER_DISPATCHED ×n (facility = source, counterpart = destination) |
| Receive | RECEIVED | destination staff (`received_by`) | IN_TRANSIT → RECEIVED → AVAILABLE; `facility_id` switches to destination; rejected units → QUARANTINED | TRANSFER_RECEIVED + INVENTORY_ACCEPTED ×n (facility = destination) |
| Cancel before dispatch | CANCELLED | either side | RESERVED → AVAILABLE | INVENTORY_RELEASED |

Within one organization (Centre A ↔ its own hospital storage), a user with authority at both
facilities may propose and approve in one step. **Traceability:** each unit's `transactions` rows record
both facilities; `transfer_items` link unit ↔ transfer; `audit_logs` record the people and decisions.

### 6.5 Source-context temporary reservation (C5, revised and approved)

**Rule:** a source-selection/allocation request may temporarily reserve eligible units atomically at the
source through the authorized backend workflow. The reservation is created within the source facility's
inventory context, not directly by the receiving organization. The source blood centre must confirm
before dispatch. If it does not confirm within the configured timeout, the hold is released automatically.

**Who can do what**

| Actor | Can | Cannot |
|---|---|---|
| Requesting-side staff (HOSPITAL_STAFF / DOCTOR / EMERGENCY_STAFF of the requesting or patient facility, VERIFIED/ACTIVE org) | ask the backend to place a hold at a chosen source for a VERIFIED request item; cancel their own pending hold | see or choose unit IDs; confirm, dispatch or issue; write any source table |
| Source blood-centre staff (BLOOD_BANK_ADMIN / BLOOD_BANK_STAFF at the source) | confirm or decline the hold, dispatch, issue | — |
| PUBLIC_REQUESTER, DONOR | nothing in this workflow | — |
| System (release job) | expire holds past `hold_expires_at` | anything else |

**Mechanism — database functions in the non-exposed `private` schema.** They run as the table owner
(`SECURITY DEFINER`) and can be executed only by the backend's database role. `anon` and `authenticated`
have no EXECUTE grant, and there is no RLS write policy anywhere. Each function re-checks every
precondition inside the database, so a backend bug cannot bypass them.

| Function | Preconditions checked in the DB | Effect (one transaction) |
|---|---|---|
| `place_source_hold(request_item, source_facility, quantity, actor)` | request VERIFIED and open; actor has an allowed requesting-side grant; source facility `accepts_temporary_holds` and its org shares availability; `allocation.hold_timeout_minutes` configured for the source; quantity ≤ item's remaining need | select eligible units at the source (`status = 'AVAILABLE'`, not expired, validated/allowed compatibility rule), first-expiry-first, `FOR UPDATE SKIP LOCKED`, `LIMIT quantity`; **all-or-nothing** — if fewer than `quantity` are available the call fails and nothing is reserved; each unit AVAILABLE → RESERVED via `transition_unit_status`; insert allocations (RESERVED, `hold_expires_at`); request → ALLOCATED |
| `confirm_hold(allocation_ids, actor)` | actor is blood-bank staff **at the source**; every allocation still RESERVED and `hold_expires_at > now()` (row locked `FOR UPDATE`) | allocations → CONFIRMED (`confirmed_by/at`); units stay RESERVED |
| `decline_hold(allocation_ids, actor, reason)` | actor is source blood-bank staff; status RESERVED | allocations → CANCELLED; units RESERVED → AVAILABLE |
| `cancel_hold(allocation_ids, actor, reason)` | actor is the requesting-side staff who can manage the request; status RESERVED | allocations → CANCELLED; units RESERVED → AVAILABLE |
| `release_expired_holds()` | allocations RESERVED with `hold_expires_at < now()`, locked `FOR UPDATE SKIP LOCKED` | allocations → EXPIRED; units RESERVED → AVAILABLE; request → OPEN if nothing else is active |
| `dispatch_allocation(...)` / `issue_allocation(...)` / `return_allocation(...)` | source staff; status CONFIRMED / DISPATCHED | RESERVED → DISPATCHED → ISSUED (→ RETURNED) |

The release job runs every minute with **pg_cron** (supported on Supabase), plus `place_source_hold`
first calls the release step for the same source. So an expired hold never blocks a new request, even if a job run is late.

**How concurrent emergency requests are prevented from claiming the same unit**

1. **Row locks with SKIP LOCKED.** Two `place_source_hold` calls at the same moment lock *different* rows: the second skips the units the first has locked and takes the next eligible ones. If not enough remain, it fails cleanly ("insufficient units at this source"), and the backend re-runs source ranking.
2. **Status is the guard.** The unit update is `… SET status = 'RESERVED' WHERE id = … AND status = 'AVAILABLE'`, so a unit that is no longer AVAILABLE can never be reserved twice.
3. **Unique active allocation.** The partial unique index `(inventory_unit_id) WHERE status IN ('RESERVED','CONFIRMED','DISPATCHED')` rejects a second active allocation even if the first two guards were bypassed.
4. **Confirm vs. timeout race.** `confirm_hold` and `release_expired_holds` both lock the allocation row, so they run one after the other. A confirmation that arrives after the deadline is refused (409). An expiry never cancels a hold that has already been confirmed.
5. **All-or-nothing.** A request item never ends up with half its units held at a source by accident.

**Ledger and audit per step**

| Step | Allocation status | Unit transition → ledger event (facility = source) | Audit action (organization) |
|---|---|---|---|
| Hold placed | RESERVED | AVAILABLE → RESERVED → INVENTORY_RESERVED (`recorded_by` null = system, linked by `request_allocation_id`) | `allocation.hold_request` (requesting org, actor = requester, no unit codes) and `allocation.hold_create` (source org, actor = requester, requesting facility named) |
| Confirmed | CONFIRMED | none (unit stays RESERVED) | `allocation.confirm` (source org) |
| Declined by source | CANCELLED | RESERVED → AVAILABLE → INVENTORY_RELEASED | `allocation.decline` (both orgs) |
| Cancelled by requester | CANCELLED | RESERVED → AVAILABLE → INVENTORY_RELEASED | `allocation.cancel` (both orgs) |
| Timed out | EXPIRED | RESERVED → AVAILABLE → INVENTORY_RELEASED (system) | `allocation.hold_expire` (both orgs, actor = system) |
| Dispatched | DISPATCHED | RESERVED → DISPATCHED → INVENTORY_DISPATCHED | `allocation.dispatch` (source) |
| Issued | ISSUED | DISPATCHED → ISSUED → INVENTORY_ISSUED | `allocation.issue` (both) — unit code visible to participants from here (§9.4) |
| Returned | RETURNED | DISPATCHED/ISSUED → RETURNED → INVENTORY_RETURNED | `allocation.return` (source) |

**Transfers use the same pattern inside one organization boundary.** When the source approves a transfer,
source staff reserve units in their own facility (`reserve_units_for_transfer`, same locking and guards).
The destination never touches source units. Internal requests (ABC Hospital → Centre A) use
`place_source_hold` too; there, requesting side and source belong to the same organization.

---

## 7. Prediction & recommendation model

### 7.1 Predictions
- **Connection:** `organization_id` + `facility_id` + `blood_group_id` + `component_id` + `horizon_days` / `period_start..period_end`.
- **Content:** demand (`predicted_daily_demand`, `predicted_quantity`), the state snapshot used (`usable_units`, `reserved_units`, `pending_request_units`, `incoming_units`), the result (`days_of_cover`, `predicted_shortage_date`, `shortage_risk`), EXPIRY outputs (`expiring_units`, `at_risk_units`), and `explanation` JSON (inputs and reasoning for WHY / DATA).
- **Provenance:** `model_name`, `model_version`, `run_id`, `generated_at`; older rows are kept with `superseded_at` for accuracy measurement later.
- **Confidence:** nullable. Stored only if the AI service returns it along with a `confidence_method`. There is no default value and no placeholder.
- **History source:** the view `v_daily_consumption` = daily count of `INVENTORY_ISSUED` transactions per facility/group/component (Asia/Kolkata days), zero-filled. This is Step 3 §29's "opening/issued/received/closing" table computed from the ledger rather than stored twice.
- **Days-of-cover formula** used for seed design (to be confirmed in Phase 6):
  `days_of_cover = (usable − pending_request_units + incoming_units) / predicted_daily_demand`.

### 7.2 Recommendations lifecycle

```text
AI run ─▶ PENDING ──Approve──▶ APPROVED ──resulting action completed──▶ EXECUTED
                  ──Modify───▶ MODIFIED ──resulting action completed──▶ EXECUTED
                  ──Reject───▶ REJECTED
                  ──valid_until passed──▶ EXPIRED
```

**How Approve / Modify / Reject will be persisted** — one backend endpoint
`POST /api/recommendations/:id/decision { decision, modified_payload?, note? }`, one DB transaction:

1. `SELECT … FOR UPDATE` the row; it must be PENDING and not past `valid_until` (a race returns 409 Conflict).
2. Check the caller's role for this `recommendation_type` at `facility_id` (§9).
3. Update `status`, `decided_by`, `decided_at`, `decision_note`, and `modified_payload` (MODIFIED; validated against the type's schema — e.g. a transfer quantity may be lowered, not raised above source surplus).
4. APPROVED/MODIFIED side effects, in the same transaction:
   - REDISTRIBUTION → insert `transfers` (PROPOSED, `recommendation_id`)
   - EMERGENCY_SOURCE → call `private.place_source_hold` (§6.5)
   - DONOR_ACTIVATION → insert `donor_activations` + recipients
   - PROCUREMENT → recorded only (no ordering system in the MVP; marked EXECUTED manually when the order is placed)
5. Write `audit_logs` ('recommendation.approve' | '.modify' | '.reject').
6. EXECUTED is set later, when the resulting action completes (transfer RECEIVED, allocations ISSUED, activation sent).

After any change to inventory, requests or transfers, the backend triggers an AI recalculation;
superseded predictions are closed and PENDING recommendations whose basis changed become EXPIRED.

### 7.2a Recommended transfer quantity (decision 6 — never hard-coded)

All inputs come from the database and `planning_parameters`; the formula lives in the AI service and is reviewed in Phase 6. Structure:

```text
destination (D), per blood group g and component c:
  projected_supply_D = usable_D − pending_request_units_D + incoming_D
  current_cover_D    = projected_supply_D / forecast_daily_demand_D
  deficit_D          = ceil( coverage.target_days(D,g,c) × forecast_daily_demand_D − projected_supply_D )
source (S), same g and c:
  shareable_S        = usable_S − pending_request_units_S − ceil( reserve.floor_days(S,g,c) × forecast_daily_demand_S )
quantity             = min( deficit_D, shareable_S, transfer.max_units )
recommend only if    quantity ≥ transfer.min_units and current_cover_D < coverage.target_days(D,g,c)
```

**Reproducibility without leaking source data (U1):** destination-side terms (demand, cover, deficit, target) are stored in the recommendation's `payload` / `data_explanation`, which the destination organization reads. Source-side internals (the source's demand, reserve floor, exact cover) stay in the **source's own** SHORTAGE/DEMAND prediction rows, visible only to the source organization; the recommendation references them by `source_prediction_id` and stores only the shared outputs (`source_can_fulfil`, `source_spare_units`, `near_expiry_opportunity`, ETA). Auditors with platform access can recompute the full number from both records. If no source has `shareable_S > 0`, no REDISTRIBUTION is produced and the shortfall flows to PROCUREMENT / DONOR_ACTIVATION instead.

### 7.3 Payload shapes (validated with zod in the backend)

| Type | payload |
|---|---|
| REDISTRIBUTION | `{ source_facility_id, destination_facility_id, blood_group_id, component_id, quantity, destination_cover_before_days, destination_cover_after_days, destination_prediction_id, source_prediction_id, source_can_fulfil, source_spare_units, near_expiry_opportunity, eta_minutes, parameters_used }` — no source cover, demand or expiry dates |
| PROCUREMENT | `{ facility_id, blood_group_id, component_id, quantity, target_cover_days }` |
| EMERGENCY_SOURCE | `{ request_item_id, ranked: [{ facility_id, can_fulfil, spare_units_above_reserve, near_expiry_opportunity, distance_km, eta_minutes, rank, excluded_reason? }] }` — per-source outputs only; the source's internal cover stays in its own predictions |
| DONOR_ACTIVATION | `{ facility_id, blood_group_id, component_id, units_needed, eligible_donor_count, radius_km }` |

---

## 8. Donor activation model

```text
SHORTAGE prediction (still short after stock, incoming and redistribution)
  └─▶ DONOR_ACTIVATION recommendation (payload: group, component, units_needed, radius, eligible donor count)
        └─ BLOOD_BANK_ADMIN approves ─▶ donor_activations (group, component, urgency, radius_km, facility = centre, expires_at)
              └─▶ donor_activation_recipients (one per targeted donor, distance snapshot)
                    ├─ notification_status  PENDING → SENT → DELIVERED | FAILED   (in-app/Realtime; FCM later)
                    ├─ response             NO_RESPONSE → WILLING | DECLINED     (the donor, in the donor app)
                    └─ outcome              donations.activation_recipient_id    (the blood centre records it)
```

- **Targeting (a query, not medical judgement):** donors with `consent_to_contact`, `status = 'ACTIVE'`, `availability_status = 'AVAILABLE'`, a compatible blood group, within `radius_km` of the centre, and `last_donation_date` older than the configured minimum interval (parameter). Donors with an unverified blood group are included but flagged.
- **Eligibility and screening are never set by BloodLink logic.** `donations.screening_status` / `eligibility_status` are entered only by blood-centre staff; donors see "Final eligibility is confirmed at the blood centre."
- **Privacy:** blood-centre staff see a donor's details only after that donor responds WILLING, or has donated at their facility. Before that, staff see counts only.
- Funnel metrics (contacted → willing → donated → units added) are computed from recipients + donations + donation_components.

---

## 9. Authorization model

### 9.1 Identity chain

```text
auth.users (Supabase Auth: email + password, sessions, JWT)
   │ 1:1, same uuid
public.users (profile: organization, primary facility, status — no password field)
   │ 1:N
user_roles (role grant, optional organization + facility scope)
   │ N:1
roles (10 independent permission sets)
```

Staff accounts are created by an ORG_ADMIN through the backend (invite → Supabase Admin API →
`users` + `user_roles` in one transaction). Donors and public requesters self-register through the
backend and receive DONOR / PUBLIC_REQUESTER.

### 9.2 Roles and the link each requires

| Role | Scope | Organization | Facility (type) | Key permissions (enforced in Express; RLS mirrors reads) |
|---|---|---|---|---|
| SUPER_ADMIN | PLATFORM | none | none | verify organizations, manage compatibility rules and planning parameters, read all |
| ORG_ADMIN | ORGANIZATION | required | none (all org facilities) | manage users/roles in own org, decide any own-org recommendation, read all own-org data |
| HOSPITAL_STAFF | FACILITY | required | HOSPITAL / NURSING_HOME | create requests, verify requests for patients at that facility |
| DOCTOR | FACILITY | required | HOSPITAL / CLINIC / NURSING_HOME | create and verify requests, set `allow_compatible_substitutes` |
| EMERGENCY_STAFF | FACILITY | required | HOSPITAL / CLINIC / EMERGENCY_SERVICE | create emergency requests, request a source-context hold (§6.5), view issued bag codes for their requests (§9.4) |
| BLOOD_BANK_ADMIN | FACILITY | required | BLOOD_CENTRE | approve/reject transfers at source, decide redistribution/procurement/donor-activation recommendations, confirm allocations |
| BLOOD_BANK_STAFF | FACILITY | required | BLOOD_CENTRE | record donations, screening results, dispatch/receive, confirm and issue allocations |
| INVENTORY_MANAGER | FACILITY | required | any facility with `holds_inventory` | add/adjust units, quarantine/accept/waste, propose transfers |
| DONOR | SELF | none | none | own donor profile, availability, respond to activations |
| PUBLIC_REQUESTER | SELF | none | none | create, cancel and track own emergency requests only |

A user can hold several grants (e.g. Dr. Sharma: DOCTOR + EMERGENCY_STAFF at ABC Hospital).
Permission = any grant allows the action at that facility — no role outranks another (decision D).

### 9.3 Two layers
1. **Express (primary):** every route resolves the caller from the Supabase JWT → loads grants → checks the permission for the target organization/facility → then runs Prisma queries that are always scoped by organization/facility IDs. Prisma connects with a privileged role that **bypasses RLS**, so this layer is mandatory, not optional.
2. **RLS (defence in depth):** protects everything the browser can reach with the anon key — Supabase Realtime subscriptions and any direct reads.

### 9.4 Issued-unit code visibility (U7, approved with restriction)

After a unit is **ISSUED** for a request, its bag **unit code** may be shown for clinical traceability
(transfusion record, look-back), and only to people directly involved in that request or issuance:

| Who | Condition |
|---|---|
| Source blood-centre staff | own inventory — already visible |
| Requesting / patient-facility clinical staff | holds DOCTOR, HOSPITAL_STAFF or EMERGENCY_STAFF at **that request's** `patient_facility_id` or `requester_facility_id`, in a VERIFIED/ACTIVE organization |
| The staff user who created or verified that request | `requester_user_id` or `verified_by`, still holding a staff grant at one of those facilities |

**Never visible to:** public requesters (even for their own request), donors, unrelated organizations,
network users coordinating other requests, or anyone before the unit is ISSUED.

**Exposed fields:** unit code, blood group, component, issued_at, request number. **Never exposed:**
internal unit UUID, expiry date, storage location, donation link, transaction/ledger rows.

**Mechanism:** a backend endpoint backed by a `private` `SECURITY DEFINER` function
(`issued_unit_codes(request_id, actor)`) that checks the conditions above inside the database. There is
**no** RLS policy granting cross-organization access to `inventory_units` or `request_allocations`, and
every view of these codes is audited (`request.view_issued_units`).

---

## 10. RLS design (policy design only — no SQL yet)

### 10.1 Principles
- RLS enabled on **every** public table; default deny.
- **Browsers are read-only on tables.** No INSERT/UPDATE/DELETE policies for `authenticated` or `anon` on any operational table: all writes go through Express. This removes a whole class of RLS bugs and keeps business rules in one place.
- `anon` gets nothing except SELECT on reference tables (`blood_groups`, `components`) for the public emergency form.
- Helper functions in schema `private` (`SECURITY DEFINER`, `STABLE`, fixed `search_path`), looked up once per statement:
  - `private.is_super_admin()`
  - `private.org_ids()` — organizations the caller belongs to
  - `private.facility_ids(roles app_role[] default null)` — facilities where the caller holds any of the roles (ORG_ADMIN ⇒ all org facilities)
  - `private.donor_id()` — the caller's donor row
- Helpers only count grants of users with `users.status = 'ACTIVE'` in organizations that are VERIFIED or ACTIVE, so suspending a user or an organization removes read access immediately.
- **Organization isolation:** every tenant-owned row carries `organization_id` directly or through `facility_id`. Policies compare it against `private.org_ids()` / `private.facility_ids()`. Cross-organization visibility exists only where a workflow creates a shared object (a transfer or an allocation), and only for that object.

### 10.2 Policy matrix (SELECT; INSERT/UPDATE/DELETE = backend only unless noted)

| Table | Who can SELECT | Notes |
|---|---|---|
| organizations | members of that org; SUPER_ADMIN; any authenticated user sees `id, name, type` of ACTIVE orgs *via a view* | names needed for transfer/source labels |
| facilities | members of the org; SUPER_ADMIN; authenticated users see basic columns of OPERATIONAL facilities of ACTIVE orgs via a view | public requester must pick a treating hospital |
| users | self; ORG_ADMIN of the same org; SUPER_ADMIN | |
| roles | all authenticated | reference |
| user_roles | self; ORG_ADMIN of the org; SUPER_ADMIN | |
| blood_groups, components | anon + authenticated | reference |
| storage_locations | members with any role at that facility | |
| inventory_units | roles at the holding facility (`facility_ids()`) only | no cross-organization row access at all; other orgs see **aggregates only**, via backend (§10.3) |
| donors | the donor themself; blood-centre staff at a facility where the donor responded WILLING or donated | no broad donor browsing |
| donations, donation_components | the donor (own); blood-centre staff of the collecting facility | |
| requests, request_items | requester (own); staff of requester / patient / verifying facility | public requesters see only their own. A serving source organization reads **no** request rows; it gets minimum delivery data (request id/number, blood group, component, quantity, urgency, required-by, destination facility, request and verification status) from `v_served_requests` — never patient_reference, contact_phone, notes or requester identity (B(ii), 2026-09-25) |
| request_allocations | staff of the **source** facility only | rows hold unit IDs, so no cross-organization access. The requesting side sees allocation status, quantity, hold deadline, source facility name and ETA through the backend; bag codes only after ISSUED and only per §9.4 |
| transfers | staff of the source facility **and** of the destination facility | both sides trace the same record |
| transfer_items | source facility staff; destination staff only after RECEIVED (the units are then theirs) | before receipt the destination sees quantities on `transfers` only; at receipt they scan the physical bags and the backend matches them to the items |
| predictions | members of `organization_id` | |
| alerts | members of `organization_id` | |
| recommendations | members of `organization_id` | the source org sees the resulting transfer, not the recommendation |
| donor_activations | members of `organization_id` | |
| donor_activation_recipients | the donor (own row); activation org staff see rows with response = WILLING (others as counts via backend) | privacy |
| transactions | staff of `facility_id` only (where the event happened) | a transfer's source-side events stay with the source; the destination sees its own TRANSFER_RECEIVED/ACCEPTED rows |
| audit_logs | ORG_ADMIN of `organization_id`; SUPER_ADMIN | append-only, no UPDATE/DELETE even for the backend (trigger) |
| compatibility_rules | all authenticated | writes: SUPER_ADMIN via backend |
| planning_parameters | members of the org (own + defaults); SUPER_ADMIN | writes: ORG_ADMIN (own org) / SUPER_ADMIN via backend |

**DELETE:** no table allows delete from the browser. The backend deletes only draft data (e.g. a
request cancelled before any allocation is just set CANCELLED — rows stay).

### 10.3 Cross-organization network visibility (decision 3 + U1)

- Opt-in per organization (`organizations.shares_network_availability`).
- Computed only by the backend through a function in the non-exposed `private` schema. **Shared with another organization — nothing more:**
  - source facility identity (name, organization name, type, public location)
  - blood group and component
  - `can_fulfil` (yes/no for the requested quantity)
  - `spare_units_above_reserve` (count above the source's reserve floor)
  - `near_expiry_opportunity` (yes/no: the offer includes units that would otherwise risk expiring)
  - estimated distance/ETA where relevant
- **Never shared:** inventory unit IDs or codes, exact expiry dates, storage locations, internal unit records, internal requests, the source's demand, reserve floor or days of cover, and other operational details.
- **Callers:** staff with a request/transfer role in a VERIFIED/ACTIVE organization. PUBLIC_REQUESTER and DONOR callers never receive cross-organization inventory counts; public request tracking shows status and, once confirmed, the source facility name only.
- Enforced by the backend (the function is not reachable through the Data API) **and** by RLS (no cross-organization SELECT on `inventory_units`, `request_allocations`, `transfer_items` or other facilities' `transactions`).

### 10.4 Realtime
Publication `supabase_realtime` includes: `inventory_units`, `requests`, `request_allocations`,
`transfers`, `predictions`, `recommendations`, `alerts`, `donor_activation_recipients`. Realtime Postgres
Changes applies the SELECT policies above, so a subscriber only receives rows they may read.

---

## 11. Audit & transaction model

### 11.1 Three records, three purposes — no duplication of state

| Record | Question it answers | Written when | Mutable? |
|---|---|---|---|
| `inventory_units.status` (and requests.status, transfers.status…) | What is true **now**? | every state change | yes (current state) |
| `transactions` | What happened to **blood** — which unit moved where, when? | every unit state change / movement | no (append-only) |
| `audit_logs` | Which **person** did what, with what authority? | every sensitive decision or admin change | no (append-only) |

`transactions` does not duplicate `inventory_units` (current state vs. history), `requests` or `transfers`
(those hold the business object; transactions hold the per-unit events they cause). It is the AI's
history source: consumption = INVENTORY_ISSUED per day.

**Honest redundancy notes (for your decision, nothing removed silently):**
- Donations are represented only by `donations` / `donation_components` (U3). A unit's ledger starts at its creation event (COMPONENT_CREATED, PROCUREMENT_RECEIVED or INVENTORY_ADDED).
- `REQUEST_FULFILLED` is **removed** (D6 rejected): request fulfilment = `requests.status` / `fulfilled_at` + allocations ISSUED + audit `request.fulfil`. Fulfilment lead time for AI is computed from `requests.created_at` → `request_allocations.issued_at`.
- Blood group / component are copied onto transactions. Safe because they are immutable on the unit, and it makes the demand query a single-table scan.

**Three transaction types added** (reasons in §13): `INVENTORY_DISPATCHED` (RESERVED → DISPATCHED
for a request), `INVENTORY_QUARANTINED` (→ QUARANTINED), `INVENTORY_ACCEPTED` (QUARANTINED/RECEIVED/
RETURNED → AVAILABLE). Without them, three of the ten approved statuses could not be reached with a
matching ledger event.

**Canonical transition table** — the only allowed status changes, each with exactly one ledger event
(`from_status` → `to_status` stored on the row):

| From | To | Ledger event | Typical trigger |
|---|---|---|---|
| — (new unit) | QUARANTINED | COMPONENT_CREATED | component produced from a donation, awaiting screening |
| — (new unit) | QUARANTINED or AVAILABLE | PROCUREMENT_RECEIVED | unit bought from outside the network |
| — (new unit) | QUARANTINED or AVAILABLE | INVENTORY_ADDED | opening stock / manual entry |
| QUARANTINED | AVAILABLE | INVENTORY_ACCEPTED | screening passed |
| QUARANTINED | WASTED | INVENTORY_WASTED | screening failed / discarded |
| QUARANTINED | EXPIRED | INVENTORY_EXPIRED | expiry job |
| AVAILABLE | RESERVED | INVENTORY_RESERVED | allocation or approved transfer |
| AVAILABLE | ISSUED | INVENTORY_ISSUED | issued directly to own hospital ward |
| AVAILABLE | QUARANTINED | INVENTORY_QUARANTINED | recall / quality hold |
| AVAILABLE | WASTED | INVENTORY_WASTED | breakage, cold-chain failure |
| AVAILABLE | EXPIRED | INVENTORY_EXPIRED | expiry job |
| RESERVED | AVAILABLE | INVENTORY_RELEASED | allocation or transfer cancelled |
| RESERVED | DISPATCHED | INVENTORY_DISPATCHED | released to an external requester |
| RESERVED | IN_TRANSIT | TRANSFER_DISPATCHED | transfer dispatched |
| RESERVED | ISSUED | INVENTORY_ISSUED | reserved unit issued to own ward |
| RESERVED | WASTED | INVENTORY_WASTED | |
| RESERVED | EXPIRED | INVENTORY_EXPIRED | expiry job |
| DISPATCHED | ISSUED | INVENTORY_ISSUED | delivery to patient facility confirmed |
| DISPATCHED | RETURNED | INVENTORY_RETURNED | not used by requester |
| DISPATCHED | WASTED | INVENTORY_WASTED | damaged in delivery |
| IN_TRANSIT | RECEIVED | TRANSFER_RECEIVED | arrival; `facility_id` switches to destination |
| IN_TRANSIT | WASTED | INVENTORY_WASTED | lost / damaged in transit |
| RECEIVED | AVAILABLE | INVENTORY_ACCEPTED | acceptance check passed |
| RECEIVED | QUARANTINED | INVENTORY_QUARANTINED | rejected on arrival |
| RECEIVED | WASTED | INVENTORY_WASTED | |
| RECEIVED | EXPIRED | INVENTORY_EXPIRED | expiry job |
| ISSUED | RETURNED | INVENTORY_RETURNED | returned unused from ward |
| RETURNED | AVAILABLE | INVENTORY_ACCEPTED | inspection passed |
| RETURNED | QUARANTINED | INVENTORY_QUARANTINED | needs further checks |
| RETURNED | WASTED | INVENTORY_WASTED | inspection failed |

Terminal: WASTED, EXPIRED. Any pair not listed is rejected. Every one of the 10 statuses is reachable,
and every one of the 14 event types is used.

**Guarantee (D7):** `inventory_units.status` can only change through the DB function `transition_unit_status(unit, to_status, context)`. It validates the transition against this table and inserts exactly one `transactions` row in the same statement; a trigger rejects any direct status update made outside that function. So every real inventory state change has exactly one ledger record, and every ledger record matches a real change.

### 11.2 Audited actions

| Area | action values | old/new values captured |
|---|---|---|
| Request fulfilment | `request.fulfil` (replaces the REQUEST_FULFILLED ledger event) | status |
| Inventory | `inventory.add`, `.quarantine`, `.accept`, `.waste`, `.adjust` | status, storage location — never donor identity |
| Requests | `request.create`, `.verify`, `.reject_verification`, `.cancel` | verification status, note |
| Allocation | `allocation.hold_request`, `.hold_create`, `.confirm`, `.decline`, `.cancel`, `.hold_expire`, `.dispatch`, `.issue`, `.return` (§6.5) | status, quantity, source facility; unit codes only in **source-organization** audit rows |
| Traceability | `request.view_issued_units` (§9.4) | request id, viewer |
| Transfers | `transfer.propose`, `.approve`, `.reject`, `.dispatch`, `.receive`, `.cancel` | status, quantities |
| Recommendations | `recommendation.approve`, `.modify`, `.reject` | status, modified payload diff, note |
| Donor activation | `donor_activation.create`, `.cancel`; `donation.record_outcome` | counts, radius — not donor lists |
| Users / roles | `user.invite`, `.suspend`, `.reactivate`, `role.grant`, `role.revoke` | role code, scope |
| Organizations | `organization.verify`, `.suspend` | status |
| Configuration | `compatibility_rule.change`, `planning_parameter.change` | full before/after |
| Security | `auth.login_failed` (optional), `export.*` (future) | — |

**Not logged:** patient data (only the request's reference ID), donor phone/DOB/location, auth tokens,
full payloads of unchanged fields.

**Mechanism:** the backend writes the audit row in the same database transaction as the change, with
the caller's user ID, organization, facility and a correlation ID. DB triggers could not know the real
actor because Prisma connects as a service role — that is why auditing lives in the backend service
layer, not in triggers.

---

## 12. Seed-data structure

### 12.1 Principle
Seed only **facts**: organizations, facilities, users, reference data, units, donors, donations, requests,
historical transfers and the transaction ledger. **Predictions, alerts and recommendations are never
inserted by the seed.** After seeding, the seed script calls the real pipeline (`POST /api/ai/recalculate`),
so every derived number on screen is produced by the implemented logic from these facts. The generator
is deterministic (fixed random seed), so every run produces identical data.

Seed boundaries after U2/U4/U5:
- **No clinical reference values:** components get code/name/category only; compatibility gets only the DEMO_ONLY identical-group PRBC rows.
- **No planning-parameter rows until their values are explicitly approved** (Phase 6 / seed stage). Calculations that need a missing parameter fail loudly instead of using a default.
- Demo units need expiry dates. They are generated as **demo records** from a shelf-life figure declared openly in the seed script's configuration and reviewed at the seed stage (§20 U8). It is never written into `components` and never presented as clinical reference data.

### 12.2 Places (fictional, one city — placeholder Lucknow; coordinates only drive distance/ETA)

| Organization (type) | Facility (type, holds inventory) | Lat, Lng |
|---|---|---|
| ABC Hospital (HOSPITAL_BLOOD_CENTRE) | ABC Hospital (HOSPITAL, no) | 26.8500, 80.9500 |
| | **Centre A** — ABC Hospital Blood Centre (BLOOD_CENTRE, yes) | 26.8500, 80.9500 (same campus) |
| City Blood Centre (BLOOD_CENTRE) | **Centre B** (BLOOD_CENTRE, yes) | 26.9000, 81.0200 |
| Regional Blood Bank (BLOOD_CENTRE) | **Centre C** (BLOOD_CENTRE, yes) | 26.7600, 80.8800 |
| Metro Hospital (HOSPITAL) | Metro Hospital (HOSPITAL, yes — small storage, **no O− stock**) | 26.8600, 80.9200 |
| Sunrise Clinic (CLINIC) | **Sunrise Clinic** (CLINIC, no) — emergency requester | 26.8700, 80.9800 |

All blood centres have `shares_network_availability = true`.

Distances (Haversine) and **example** ETAs if the mock Maps adapter uses road factor 1.3 at 25 km/h —
both parameters still to be approved (Phase 6/7):

| Route | Straight | ETA (example params) |
|---|---|---|
| Sunrise Clinic → Centre A | 3.72 km | ≈ 12 min |
| Sunrise Clinic → Centre B | 5.18 km | ≈ 16 min |
| Sunrise Clinic → Metro Hospital | 6.05 km | ≈ 19 min (filtered out: no compatible O−) |
| Sunrise Clinic → Centre C | 15.75 km | ≈ 49 min |
| Centre B → Centre A (redistribution) | 8.89 km | ≈ 28 min |

### 12.3 Users (one per role, all fictional; passwords come from a seed-only env var, never the repo)

| User | Organization / facility | Roles |
|---|---|---|
| Platform Admin | — | SUPER_ADMIN |
| ABC org admin | ABC Hospital | ORG_ADMIN |
| Dr. Sharma | ABC Hospital (hospital) | DOCTOR, HOSPITAL_STAFF |
| Centre A admin | ABC Hospital / Centre A | BLOOD_BANK_ADMIN |
| Centre A inventory | ABC Hospital / Centre A | INVENTORY_MANAGER, BLOOD_BANK_STAFF |
| Centre B admin + staff | City Blood Centre / Centre B | BLOOD_BANK_ADMIN; BLOOD_BANK_STAFF |
| Centre C admin | Regional Blood Bank / Centre C | BLOOD_BANK_ADMIN |
| Metro staff | Metro Hospital | HOSPITAL_STAFF, INVENTORY_MANAGER |
| Sunrise emergency staff | Sunrise Clinic | EMERGENCY_STAFF |
| Demo donor (O−) | — | DONOR (linked to a donors row) |
| Demo public requester | — | PUBLIC_REQUESTER |

### 12.4 History (drives the forecast)
- 120 days of generated consumption per blood centre × blood group × component: each day's demand is drawn from a weekday-seasonal Poisson process, realised as real units (collected → ACCEPTED → ISSUED) with matching transactions, so the ledger, units and donations agree.
- **Centre A O− PRBC:** mean ≈ 4.6/day for days −120…−31, rising to ≈ 5.4/day over the last 30 days (the "demand increasing" story). The *forecast* value (expected ≈ 5.2/day) is whatever the Phase 6 model computes — it is not stored by the seed.
- Centre B O− PRBC ≈ 1.2/day; Centre C O− ≈ 2.5/day; other groups at realistic proportions.
- Some historical transfers (RECEIVED), fulfilled requests, a few WASTED/EXPIRED units, and past donations for donor histories.

### 12.5 Current state at "now" (the demo starting point)

**Centre A, O− PRBC**

| Fact | Units | How it is represented |
|---|---|---|
| Usable | 16 | AVAILABLE, 3 of them expiring within 7 days |
| Reserved | 4 | RESERVED for request R-ABC-1 (scheduled surgery, VERIFIED, allocations CONFIRMED) |
| Incoming | 2 | QUARANTINED — collected yesterday, screening pending |
| Pending demand | 2 | request R-ABC-2 (ROUTINE, VERIFIED, OPEN, not yet allocated) |

⇒ with the §7.1 formula and a forecast of ≈ 5.2/day: (16 − 2 + 2) / 5.2 ≈ **3.1 days of cover** → shortage predicted.

**Transfer quantity is computed, never seeded or hard-coded** (decision 6, formula §7.2a). The seed
inserts `coverage.target_days` and `reserve.floor_days` rows in `planning_parameters`; the result follows
from them. For illustration only, with a forecast of 5.2/day and Centre B's shareable surplus well above
the deficit: target 4 days → 5 units, 5 days → 10, 7 days → 21. The seeded parameter values are chosen
explicitly at the seed stage (U4 approved deferral); the displayed number must then follow from them.

**Centre B, O− PRBC:** 32 AVAILABLE, of which 6 expire within 3 days; demand ≈ 1.2/day ⇒ ≈ 26.7 days of
cover and ≈ 2–3 of those 6 units at risk of expiring unused → Centre B is a genuine surplus source, and
sending the near-expiry units to Centre A (which uses ≈ 5/day) prevents waste.

**Centre C, O− PRBC:** 40 AVAILABLE, demand ≈ 2.5/day ⇒ ≈ 16 days; farther away.
**Metro Hospital:** O+/A+/B+ only → excluded from O− matching by `compatibility_rules`, not by the AI.

**Emergency (created live during the demo, not seeded):** Sunrise Clinic, O− PRBC × 2, CRITICAL.
Compatibility here relies on the seeded DEMO_ONLY O−→O− PRBC rule. Candidates after the compatibility filter: Centre A (closest, but already short — reserve check),
Centre B (surplus), Centre C (far). Which one ranks first is decided by the Phase 6 scoring rules; the
data guarantees a centre is never shown as a surplus source while its own prediction is critical.

**Donors:** 60 donors; 18 are O−. Exactly **12** O− donors are consenting, ACTIVE, AVAILABLE, within 10 km
of Centre A and last donated > 120 days ago (so they qualify under any minimum-interval setting ≤ 120
days). The other 6 are deliberately excluded: 3 beyond 20 km, 2 donated within 60 days, 1 UNAVAILABLE.
This produces the documented "12 relevant donors near the centre".

### 12.6 Consistency checks (run as database tests after seeding)
- Every AVAILABLE/RESERVED unit has a COMPONENT_CREATED (or PROCUREMENT_RECEIVED / INVENTORY_ADDED) transaction, and its latest transaction's `to_status` equals its status.
- Σ ISSUED transactions per day = `v_daily_consumption`.
- Every active allocation's unit is RESERVED/DISPATCHED and compatible; no unit has two active allocations.
- Every IN_TRANSIT unit belongs to exactly one IN_TRANSIT transfer.
- `donors.total_donations` / `last_donation_date` match `donations`.
- Centre A O− usable = 16, reserved = 4, incoming = 2, pending = 2 at seed time.

---

## 13. Existing vs new fields

### A. Preserved from the Step 3 specification
- All 23 Step 3 tables and their purposes, including the unit-level inventory principle (§9–10), donation ≠ unit (§13), request → item → allocation traceability (§17), transfers + items (§18–19), predictions with context (§20), alerts (§21), donor activation separate from alerts (§22), a transaction ledger separate from audit logs (§23–24) and configurable compatibility rules (§25).
- Every Step 3 column, except the ones listed in D3 and D5 below (moved or dropped, with reasons).
- All 10 inventory statuses, the 6 organization types, the 10 roles, the 6 transfer statuses, request_type (emergency/routine/bulk), urgency (critical/high/normal), organization status, donor status, alert severity/status/type values and 11 of the 13 Step 3 transaction types (REQUEST_FULFILLED and DONATION_RECEIVED removed — D6, U3).
- `donor_activation_recipients` exactly as Step 3 §22 sketched it (now MVP per decision E).
- The MVP component set (WHOLE_BLOOD, PRBC, PLASMA_FFP, PLATELETS), extensible.

### B. Newly introduced fields (★ in §3)

| Table | New fields |
|---|---|
| organizations | shares_network_availability, verified_at |
| facilities | holds_inventory, accepts_temporary_holds; enum values for facility_type / operating_status |
| users | status enum values (spec had "status") |
| roles | scope |
| user_roles | id, organization_id, facility_id, granted_by, granted_at |
| blood_groups | display_name, abo, rhd, is_known, sort_order |
| components | category enum values; values_validation_status, values_source_reference, values_validated_by, values_validated_at (clinical values made nullable) |
| storage_locations | enum values for type / status |
| inventory_units | status_changed_at |
| donors | blood_group_verified, consent_to_contact, preferred_facility_id |
| donations | activation_recipient_id, recorded_by; enum values for screening/eligibility |
| requests | verification_method, request_number, patient_facility_id, verifying_facility_id, contact_phone, verified_by, verified_at, verification_note, cancelled_at, fulfilled_at; request_status values |
| request_items | allow_compatible_substitutes |
| request_allocations | hold_expires_at, source_facility_id, recommendation_id, confirmed_by, confirmed_at, dispatched_at, issued_at, cancelled_at, cancel_reason; allocation_status values |
| transfers | transfer_number, blood_group_id, component_id, requested_quantity, approved_quantity, recommendation_id, rejected_by, rejection_reason, dispatched_by, received_by, approved_at, cancelled_at, estimated_transit_minutes, updated_at |
| transfer_items | id, accepted, created_at |
| predictions | run_id, organization_id, horizon_days (renamed from prediction_horizon), period_start, period_end, predicted_daily_demand, usable_units, reserved_units, pending_request_units, incoming_units, expiring_units, at_risk_units, days_of_cover, shortage_risk, confidence_method, model_name, superseded_at; explanation becomes jsonb |
| alerts | recommendation_id, request_id, transfer_id, dedupe_key, acknowledged_by/at, resolved_by |
| donor_activations | organization_id, recommendation_id, urgency, radius_km, donor_message, activated_by, expires_at, updated_at |
| donor_activation_recipients | id, distance_km, notified_at, created_at |
| recommendations | (whole table per decision F) plus priority, related_request_id, modified_payload, model_version, dedupe_key, valid_until, decision_note, executed_at; data_explanation typed as jsonb |
| transactions | all columns except id and type (Step 3 did not define columns); no donation_id (U3) |
| audit_logs | facility_id, correlation_id |
| compatibility_rules | validation_status, source_reference, source_url, validated_by, validated_at, validation_note, created_at, updated_at |
| (new table) | planning_parameters (incl. blood_group_id / component_id scope) |
| enums | verification_method, rule_validation_status; transaction types INVENTORY_DISPATCHED, INVENTORY_QUARANTINED, INVENTORY_ACCEPTED |

---

## 14. Assumptions (C1–C12)

Resolved: **C3** (decision 3 + U1), **C4** (decision 2), **C9** (U5 — no clinical values seeded), **C10** (U2 — DEMO_ONLY only).
**U6 decisions (2026-09-25):** C1, C2, C6, C7, C8, C11, C12 **approved as written**; C5 **approved as modified** (source-context reservation, §6.5).

| ID | Exact assumption | Why it is needed | Schema impact | Proposed default | Risk if wrong |
|---|---|---|---|---|---|
| C1 | A Hospital + Blood Centre organization is **one** organization with **separate** HOSPITAL and BLOOD_CENTRE facilities. Blood stock is owned by the blood-centre facility (ABC → Centre A); the hospital facility consumes it through requests/issues. | Step 5 §15 and Workflow 7 require one workspace; inventory, predictions and roles are per facility. | `facility_type`, `holds_inventory`, org-type ↔ facility-type trigger, facility-scoped roles. | As stated. | If the hospital and its blood centre should be a single facility, demand, inventory and role scoping must be merged — a data migration. |
| C2 | A hospital-only organization **may** hold blood in its own storage when its facility has `holds_inventory = true` (off by default). | Workflow 1 has hospitals "monitor available/allocated stock". | `holds_inventory`; units, predictions and PROCUREMENT recommendations possible at hospital facilities. | Allowed, off by default. | If hospitals never hold stock, the flag stays false; low risk. |
| C5 (revised, approved) | A source-selection request may temporarily reserve eligible units **atomically at the source through the authorized backend workflow**; the reservation is executed in the source facility's inventory context, not by the receiving organization. The source must confirm before dispatch; unconfirmed holds are released after the source's `allocation.hold_timeout_minutes`. Two requests can never reserve the same unit. | Stops two urgent requests claiming the same bag while the source is confirming, without giving the receiving organization write access to another organization's inventory. | `facilities.accepts_temporary_holds`; allocation_status RESERVED/CONFIRMED/EXPIRED; `hold_expires_at`; `private` hold/confirm/decline/cancel/release functions; partial unique index; pg_cron release job (§6.5). | Hold only at sources that opt in, with a timeout configured per source (value at the seed stage). | Low, because it's mitigated: no cross-org write privilege exists; every step is audited in both organizations. |
| C6 | A transfer carries **one** blood group + component; a mixed shipment is several transfer records. | Gives requested/approved quantity a single, unambiguous home (D5 condition). | `transfers.blood_group_id`, `component_id`, `requested_quantity`, `approved_quantity`; 1 REDISTRIBUTION recommendation → 1 transfer. | As stated. | Mixed shipments show as several transfers; if one record per shipment is needed, add `transfer_lines` later. |
| C7 | Daily demand and consumption are grouped by **Asia/Kolkata** calendar days; all timestamps are stored in UTC. | The forecast needs consistent day boundaries. | `v_daily_consumption` uses `AT TIME ZONE 'Asia/Kolkata'`. | As stated. | Facilities in other time zones would get shifted days; fix by adding `facilities.timezone`. |
| C8 | Donor location is stored **approximately** (rounded to ~1 km) and used for targeting only when `consent_to_contact` is true; no street address is stored. | Donor privacy; activation only needs a rough distance. | `donors.latitude/longitude` rounded by trigger; targeting query filters on consent. | ~1 km rounding (2 decimal places). | Distances near the radius edge are off by up to ~1 km; exact addresses would need a privacy review. |
| C11 | Users are **never hard-deleted**, only deactivated (`status`); `users → auth.users` is ON DELETE RESTRICT; audit logs keep the actor as a plain UUID. | Audit and ledger history must stay intact. | FK behaviour, user_status, RLS helpers ignore non-ACTIVE users. | As stated. | Legal deletion requests need an anonymization procedure (future); deleting an auth user from the Supabase dashboard will fail by design. |
| C12 | Approving a PROCUREMENT recommendation **records the decision only**; there is no purchase-order table in the MVP, and EXECUTED is set manually when the order is placed. | procurement_orders is Tier 3 in Step 3. | No procurement tables; recommendation status only. | As stated. | Ordered-but-not-received procurement is invisible to "incoming supply", so forecasts may over-recommend until units arrive. |

**What each assumption touches:**

| Area | C1 | C2 | C5 | C6 | C7 | C8 | C11 | C12 |
|---|---|---|---|---|---|---|---|---|
| Organization boundaries | ● | | ● (cross-org hold) | | | | ● | |
| Facility relationships | ● | ● | | | | | | |
| Inventory ownership | ● | ● | ● | | | | | |
| Request verification | | | ● | | | | | |
| Transfers | | | | ● | | | | |
| Donor activation | | | | | | ● | | |
| RLS | ● | ● | ● | | | ● | ● | |
| Audit logging | | | ● | ● | | | ● | |
| AI predictions | ● | ● | | | ● | | | ● |
| Recommendations | | ● | | ● | | | | ● |

## 15. Conflicts found (D1–D8)

| # | Conflict | Proposed resolution |
|---|---|---|
| D1 | Step 3 `users.password_hash` vs decision C (Supabase Auth). | Removed; credentials live only in `auth.users`. *(Already approved.)* |
| D2 | Step 3 Tier 2 lists `storage_locations`, `donor_activations`, `audit_logs`, `compatibility_rules`; decision E and your Phase 3 brief make them MVP. | All MVP. `storage_locations` and `audit_logs` are promoted too because the inventory table shows Location and audit is required by the brief. |
| D3 | Step 3 puts `recommended_quantity` and `recommendation_type` on `predictions`; decision F creates `recommendations`. | **Approved:** moved to `recommendations`. |
| D4 | Step 3 `prediction_type` includes PROCUREMENT, but procurement is an action, not a forecast. | **Approved:** enum = DEMAND, SHORTAGE, EXPIRY; procurement is a PROCUREMENT recommendation. |
| D5 | Step 3 `transfer_items` has `component_id` and `quantity`, but items are individual units. | **Approved with condition:** unit-level items; planned `requested_quantity` / `approved_quantity` retained on `transfers` before units are assigned (§3.16). |
| D6 | Transaction type REQUEST_FULFILLED is request-level and duplicates request status + INVENTORY_ISSUED. | **Rejected as a ledger event:** removed from `transaction_type`; fulfilment = request status + allocations + audit. |
| D8 | Step 3 lists DONATION_RECEIVED as a transaction type, but it is not a unit state change. | **Approved removal (U3):** donations live in `donations` / `donation_components`; `transactions.donation_id` dropped. |
| D7 | Step 3 statuses can't express every transition. | **Approved:** INVENTORY_QUARANTINED, INVENTORY_ACCEPTED, INVENTORY_DISPATCHED added; `transition_unit_status()` is the only way to change status (§11.1). |

Also noted (no schema impact): Step 3 §33 draws INVENTORY and INVENTORY_UNITS as two boxes; there is
deliberately only one table (`inventory_units`) — aggregates are views.

---

## 16. MVP vs future

| Required for MVP | Useful later (column/table exists or is easy to add) | Deliberately deferred |
|---|---|---|
| All 25 tables + planning_parameters (if approved) | per-user alert read state (`alert_reads`) | blood_camps (and `donations.camp_id`) |
| views v_inventory_summary, v_daily_consumption | nested storage (`storage_locations.parent_location_id`) | procurement_orders / procurement_items |
| DB functions: transition_unit_status, source-context hold functions (§6.5), expiry job, pg_cron hold release | `storage_locations.capacity`, `donors.preferred_facility_id` | cold_chain_events, transport_tracking |
| RLS read policies + private helpers | prediction accuracy tracking from superseded predictions (model_metrics) | screening_records, quality_control_records |
| Realtime publication | network partnerships table (replace the boolean opt-in) | FCM device tokens table (notification_device_tokens) |
| Append-only triggers (transactions, audit_logs) | PostGIS for spatial queries | notification_preferences |
| Seed + consistency tests | JWT custom claims hook (org/roles in token) | e-RaktKosh external availability snapshots |

---

## 17. Schema risks

| # | Area | Risk | Mitigation |
|---|---|---|---|
| F1 | Supabase RLS | Prisma connects as a privileged role and bypasses RLS: a missing org filter in one backend query leaks data. | Every repository method takes `organizationId`/`facilityId` explicitly; route-level permission guard; tests that call each endpoint as a user of another org and expect 403/empty. |
| F2 | Supabase RLS | Policies with sub-selects on large tables (inventory_units, transactions) get slow. | `SECURITY DEFINER` helpers called once per statement, indexes on `facility_id`; optionally org IDs + roles in JWT claims later. |
| F3 | Prisma | `db pull` does not represent partial indexes, CHECKs, triggers, RLS or `auth` schema FKs. | Never run `prisma migrate`; SQL migrations are the only writer; Prisma is read-model only. The `users → auth.users` FK is omitted from the Prisma model on purpose. |
| F4 | Prisma | `numeric` maps to `Decimal`; transaction pooler (port 6543) breaks prepared statements. | Serialize Decimal to number at the API boundary; `?pgbouncer=true` on DATABASE_URL, DIRECT_URL for introspection. |
| F5 | AI predictions | Forecast quality depends on seeded history; flat or unrealistic history gives meaningless forecasts. | 120 days of seasonal, trending seeded history; the model and its backtest are reviewed in Phase 6. |
| F6 | Inventory consistency | `inventory_units.reserved_for_request_id` duplicates the active allocation and can drift. | Maintained only inside the §6.5 hold/release functions + a consistency test; option: drop it and rely on the allocation's partial unique index. |
| F7 | Concurrent transfers / allocations | Two requests or approvals picking the same unit. | §6.5: `FOR UPDATE SKIP LOCKED` selection, status-guarded update, partial unique index on active allocations, all-or-nothing holds, row-locked confirm vs. expiry; endpoints idempotent (409 on stale state). |
| F8 | Emergency fulfilment | Network query + Maps + AI ranking must be fast; the AI service may be down. | Compatibility filter and availability are pure SQL; if the AI service is unavailable, the backend returns candidates ordered by ETA with a clear "ranking unavailable" flag — never an unfiltered list. |
| F9 | Inventory/donor consistency | `donors.last_donation_date` / `total_donations` and `request_items.quantity_fulfilled` are denormalized. | Updated in the same transaction as the source rows; covered by consistency tests; could become views later. |
| F10 | Auditability | Audit rows written by application code can be forgotten. | One `auditService` called by every mutating service method; a test asserts an audit row exists for each listed action; append-only triggers. |
| F11 | Expiry | A late expiry job leaves EXPIRED units shown as AVAILABLE. | Every availability query also filters on `expiry_date > now()`. |
| F12 | Enum evolution | Postgres enums cannot drop values easily. | Only stable domains are enums; audit actions, component and blood-group codes are text/rows. |
| F13 | Planning parameters | Scoped overrides make it unclear which value applied; a deleted default silently breaks calculations. | One SQL resolver, echoed into every prediction/recommendation; missing key = explicit error; changes audited. |
| F15 | Hold release | If the release job stops, expired holds keep units RESERVED and stock looks lower than it is. | pg_cron every minute + release-before-place for the same source; `hold_expires_at` visible to both sides; a monitoring query/alert on overdue holds. |
| F16 | Cross-org mutation path | A future endpoint could write another organization's inventory directly. | Only `private` SECURITY DEFINER functions touch allocations/unit status; direct writes blocked by trigger; tests assert a requesting-org user cannot change any source row except through `place_source_hold`/`cancel_hold`. |
| F14 | Compatibility (demo) | DEMO_ONLY rules could be mistaken for validated clinical rules. | Separate status, env flag off by default, visible UI notice, production start-up check refuses DEMO_ONLY. |

---

## 18. Recommended implementation order (after your approval)

1. **Migration 001 – foundation:** extensions, `private` schema, enums, `set_updated_at`, reference tables (blood_groups, components, roles, compatibility_rules) + their seed.
2. **Migration 002 – tenancy & identity:** organizations, facilities, users, user_roles, planning_parameters; scope/type validation triggers.
3. **Migration 003 – inventory & donors:** storage_locations, donors, donations, inventory_units, donation_components, transactions; transition function; immutability and append-only triggers; `v_inventory_summary`, `v_daily_consumption`.
4. **Migration 004 – requests & transfers:** requests, request_items, request_allocations, transfers, transfer_items; §6.5 hold functions + pg_cron release job, verification and compatibility triggers.
5. **Migration 005 – intelligence:** predictions, recommendations, alerts, donor_activations, donor_activation_recipients.
6. **Migration 006 – security:** audit_logs, RLS enable + policies, grants/revokes, Realtime publication.
7. **Apply to the hosted project** (after you provide credentials), `prisma db pull`, generate the Prisma client.
8. **Backend data access:** repositories per domain + `auditService` + permission guard.
9. **Seed generator** (deterministic) → run pipeline hook placeholder until the AI service lands in Phase 6.
10. **Database tests:** constraints, transitions, concurrency (double reservation), RLS as different users, seed consistency checks (§12.6).

---

## 19. Decision reconciliation (reviews of 2026-09-25)

| # | Original proposal | Your decision | Resulting schema change |
|---|---|---|---|
| 1 | Optional `planning_parameters` | **Approved**, scoped by facility + group + component | Table with group/component scope, resolver, audited; no values in AI code (§3.26) |
| 2 | Staff of verified orgs self-verify; public pending | **Approved**, backend-enforced | `verification_method`; creator-role trigger; public blocked at CHECK/function/backend/RLS (§3.13, §6.2) |
| 3 | Opt-in network visibility | **Approved** with privacy clarification | No cross-org RLS on unit tables; backend-only aggregates (§10.3) |
| 4 | Seed ABO/RhD rules "validated for demo" | **Architecture approved**; clinical validation pending | `validation_status` + reference/approval metadata (§3.25) |
| D3 / D4 | Recommendation fields on predictions; PROCUREMENT prediction | **Approved** move / removal | predictions = forecasts only; types DEMAND/SHORTAGE/EXPIRY |
| D5 | Unit-level transfer_items | **Approved**, planned quantity retained | requested/approved quantity on `transfers` (§3.16) |
| D6 | REQUEST_FULFILLED ledger event | **Rejected** | Removed; audit + status (§11) |
| D7 | New ledger event types | **Approved** | 30-row canonical transition table (§11.1) |
| 6 | Transfer quantity examples | **Never hard-code** | Formula §7.2a from records + parameters |
| U1 | Minimum shared data | **Approved** | can_fulfil, spare above reserve, group, component, near-expiry flag, ETA only (§10.3) |
| U2 | Compatibility reference | **Nothing VALIDATED**; DEMO_ONLY allowed | 8 identical-group PRBC DEMO_ONLY test rows only (§5.4) |
| U3 | DONATION_RECEIVED | **Removed** | 14 unit-lifecycle events; `transactions.inventory_unit_id` NOT NULL (§3.23) |
| U4 | Starting parameter values | **Deferred** | No rows until approved; missing = explicit error (§12.1) |
| U5 | Shelf life / temperatures | **Do not invent** | Nullable clinical fields + validation metadata; none seeded (§3.7) |
| U6 | C1, C2, C6, C7, C8, C11, C12 | **Approved as written** | As documented in §14 |
| U6·C5 | Requesting side's selection immediately holds units at the source | **Modified**: reservation executed in the source context by the authorized backend workflow; source confirms before dispatch; timeout release; no double reservation; atomic | `facilities.accepts_temporary_holds`, `request_allocations.hold_expires_at`, allocation status EXPIRED, `private` hold/confirm/decline/cancel/release functions, pg_cron release, per-step ledger + two-sided audit (§6.5) |
| U7 | Unit code visible after issue | **Approved with restriction** | Visible only to the request's clinical participants through a `private` function + audit; never public/donor/unrelated/network; no RLS change (§9.4) |
| U8 | Demo shelf life + starting parameters | **Deferred** to seed implementation | No schema change; no production defaults |

---

## 20. Open issues

| # | Issue | Blocks migrations? | Blocks production? |
|---|---|---|---|
| U2 | Authoritative compatibility reference and clinical approver; until then only DEMO_ONLY rules exist. | No | **Yes** |
| U5 | Authoritative component shelf-life / storage values. | No (no structural dependency: expiry comes from the bag label) | Yes, before any feature relies on them |
| U8 | Demo shelf-life figure for generated expiry dates and starting planning-parameter values, finalized during seed implementation; no arbitrary production defaults. | No | No |

No open issue changes table structure. **The schema is ready for your final approval.**

---

## 21. Final consistency review (revision 4)

### 21.1 Focus checks

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Receiving organization cannot directly mutate cross-org inventory | ✅ Pass | No RLS write policies anywhere; allocations/unit status change only through `private` SECURITY DEFINER functions executable by the backend role only; `place_source_hold` is the single cross-org entry point, runs in the source context with the source's opt-in, and never lets the requester choose unit IDs; direct writes rejected by trigger (§6.5, F16) |
| 2 | Temporary reservation is atomic and concurrency-safe | ✅ Pass | One transaction; `FOR UPDATE SKIP LOCKED`; status-guarded update; all-or-nothing (§6.5) |
| 3 | Two emergency requests cannot reserve the same unit | ✅ Pass | Three independent guards: row locks, `status = 'AVAILABLE'` condition, partial unique index on active allocations (§6.5) |
| 4 | Source confirmation required before dispatch | ✅ Pass | CHECK: DISPATCHED/ISSUED/RETURNED need `confirmed_by/at`; `dispatch_allocation` requires CONFIRMED and source staff (§3.15, §6.5) |
| 5 | Timeout releases the unit correctly | ✅ Pass | `release_expired_holds` (pg_cron, every minute + release-before-place): allocation → EXPIRED, unit RESERVED → AVAILABLE with INVENTORY_RELEASED, request re-opened; row lock prevents expiring a confirmed hold (§6.5, F15) |
| 6 | Every reservation/status step has the right ledger/audit event | ✅ Pass | §6.5 step table; every unit change is one of the 30 canonical transitions (§11.1); confirmation (no unit change) is audit-only, as intended |
| 7 | RLS isolates organization-owned inventory | ✅ Pass | `inventory_units`, `request_allocations`, `transfer_items`, `transactions` readable only by the owning facility (§10.2); cross-org data only via backend aggregates (§10.3) |
| 8 | Backend authorization mandatory | ✅ Pass | Prisma bypasses RLS → route guards are the primary layer; DB functions re-check preconditions as a second layer (§9.3, §6.5, F1) |
| 9 | U7 visibility restricted to request participants | ✅ Pass | §9.4: only after ISSUED, only clinical staff of that request's facilities or its creator/verifier; public, donors, unrelated orgs and network users excluded; UUID/expiry/storage/ledger never exposed; audited |
| 10 | No clinical values invented | ✅ Pass | components' clinical fields null; no VALIDATED compatibility rule; DEMO_ONLY rows labelled test data; no planning values or timeouts seeded before approval |
| 11 | U8 needs no schema change | ✅ Pass | U8 only fills rows (`planning_parameters`) and seed-script configuration |
| 12 | Previous 14 checks still pass | ✅ Pass | see 21.2 |

### 21.2 The 14 earlier checks, re-run against revision 4

| # | Check | Result |
|---|---|---|
| 1 | No recommendation fields duplicated in predictions | ✅ |
| 2 | PROCUREMENT is not a prediction type | ✅ |
| 3 | REQUEST_FULFILLED is not a ledger event | ✅ |
| 4 | DONATION_RECEIVED is not a ledger event | ✅ |
| 5 | transfer_items unit-level; requested/approved quantity on transfers | ✅ |
| 6 | Inventory totals derived, not stored | ✅ (known denormalized non-inventory counters: F6, F9) |
| 7 | Cross-org unit-level inventory private | ✅ (strengthened: no cross-org mutation path; U7 function-only access) |
| 8 | Public requesters cannot allocate, confirm, dispatch or release | ✅ (`place_source_hold` rejects them; confirm/dispatch need source staff) |
| 9 | Compatibility rules can stay DEMO_ONLY | ✅ |
| 10 | Planning parameters configurable and scoped | ✅ (adds `allocation.hold_timeout_minutes`, source-scoped) |
| 11 | No clinical values invented | ✅ |
| 12 | Every status transition has a ledger event | ✅ (30 transitions, 10 statuses reachable, 14 events used — re-verified by script) |
| 13 | Compatible with Supabase RLS + backend authorization | ✅ (pg_cron and `private` SECURITY DEFINER functions are standard on Supabase) |
| 14 | Compatible with Prisma | ✅ (Prisma calls the hold functions with `$queryRaw`; functions, partial indexes, triggers and pg_cron jobs live in SQL migrations only) |
