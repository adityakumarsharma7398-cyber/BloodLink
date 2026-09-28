# BloodLink AI — Step 3: Database & Data Model

**Project:** BloodLink AI  
**Step:** 3 — Database & Data Model  
**Status:** Finalized conceptual data model  
**Recommended database:** PostgreSQL  
**Recommended ORM:** Prisma

---

## 1. Purpose

This step defines exactly what BloodLink AI needs to store and how the major data domains fit together.

The database must support four major requirements:

1. **Operational state** — what is happening now?
2. **Historical records** — what happened?
3. **AI intelligence** — what is likely to happen?
4. **Action tracking** — what does BloodLink recommend and what did humans actually do?

The core principle is:

> **State tables tell us what exists now. Transaction tables tell us what happened. Prediction tables tell us what AI expects. Alerts and recommendations tell us what BloodLink suggests doing.**

---

# 2. High-Level Data Domains

BloodLink's database is organized into these domains:

```text
Organizations
      ↓
Facilities
      ↓
Users / Roles

Donors
      ↓
Donations
      ↓
Donation Components
      ↓
Inventory Units

Requests
      ↓
Request Items
      ↓
Request Allocations

Transfers
      ↓
Transfer Items

Predictions
      ↓
Alerts
      ↓
Donor Activations

Transactions
Audit Logs
```

---

# 3. Core Tables

The primary database tables are:

```text
1. organizations
2. facilities
3. users
4. roles
5. user_roles

6. blood_groups
7. components
8. storage_locations
9. inventory_units

10. donors
11. donations
12. donation_components

13. requests
14. request_items
15. request_allocations

16. transfers
17. transfer_items

18. predictions
19. alerts
20. donor_activations

21. transactions
22. audit_logs
23. compatibility_rules
```

Not every table needs to be implemented in the first hackathon MVP. The MVP priority is defined later in this document.

---

# 4. Organizations

An organization represents the top-level entity using BloodLink.

Possible types:

```text
HOSPITAL
BLOOD_CENTRE
HOSPITAL_BLOOD_CENTRE
CLINIC
NURSING_HOME
OTHER_AUTHORIZED_PROVIDER
```

## `organizations`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| name | Organization name |
| type | Organization type |
| registration_number | Official registration identifier |
| licence_number | Blood-centre licence where applicable |
| phone | Contact number |
| email | Contact email |
| website | Optional website |
| status | pending / verified / suspended / active |
| created_at | Creation timestamp |
| updated_at | Last update |

One organization can operate multiple facilities.

---

# 5. Facilities

A facility represents a physical operating location.

## `facilities`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| organization_id | Parent organization |
| name | Facility name |
| facility_type | Hospital / blood centre / etc. |
| address | Physical address |
| city | City |
| district | District |
| state | State |
| pincode | Postal code |
| latitude | Geographic latitude |
| longitude | Geographic longitude |
| phone | Contact number |
| operating_status | Current operating status |

### Why facilities are separate

One organization could have:

```text
Apollo Healthcare
    │
    ├── Delhi Hospital
    ├── Noida Hospital
    ├── Ghaziabad Blood Centre
    └── Lucknow Blood Centre
```

Facility-level data is also required for:

- Distance calculations
- Emergency source ranking
- Network redistribution
- Inventory ownership
- ETA estimation

---

# 6. Users & Roles

## `users`

Users represent people operating BloodLink.

| Field | Purpose |
|---|---|
| id | Primary identifier |
| organization_id | Associated organization |
| facility_id | Associated facility |
| name | Full name |
| email | Email |
| phone | Phone |
| password_hash | Authentication credential |
| status | Account status |
| last_login_at | Last login |
| created_at | Creation timestamp |

## `roles`

Recommended roles:

```text
SUPER_ADMIN
ORG_ADMIN
HOSPITAL_STAFF
DOCTOR
EMERGENCY_STAFF
BLOOD_BANK_ADMIN
BLOOD_BANK_STAFF
INVENTORY_MANAGER
DONOR
PUBLIC_REQUESTER
```

## `user_roles`

A separate many-to-many table allows one user to have multiple roles.

```text
user_id
role_id
```

Example:

```text
Dr. Sharma
    │
    ├── DOCTOR
    └── EMERGENCY_STAFF
```

---

# 7. Blood Groups

## `blood_groups`

Blood groups should be stored as reference data rather than hardcoded throughout the application.

Initial values:

```text
A+
A-
B+
B-
AB+
AB-
O+
O-
```

Optional:

```text
UNKNOWN
```

for incomplete emergency information.

---

# 8. Blood Components

A component defines the type of blood product.

## `components`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| code | Short code |
| name | Component name |
| category | Component category |
| storage_temp_min | Minimum storage temperature |
| storage_temp_max | Maximum storage temperature |
| typical_storage_days | Configurable storage duration |
| active | Whether component is currently supported |

Possible components:

```text
WHOLE_BLOOD
PRBC
FFP
PLASMA
PLATELET_CONCENTRATE
SINGLE_DONOR_PLATELET
SINGLE_DONOR_PLASMA
CRYOPRECIPITATE
```

For the hackathon MVP, the initial supported set can be simplified to:

```text
WHOLE_BLOOD
PRBC
PLASMA_FFP
PLATELETS
```

The schema should remain extensible so additional component types can be added later.

---

# 9. Inventory Units

## Critical design decision

Do **not** store inventory only as aggregate quantities.

Avoid:

```text
O+ PRBC = 120
```

Instead, store individual units/components:

```text
UNIT001 → O+ → PRBC → available → expires 12 Oct
UNIT002 → O+ → PRBC → available → expires 14 Oct
UNIT003 → O+ → PRBC → reserved → expires 15 Oct
```

## `inventory_units`

| Field | Purpose |
|---|---|
| id | Internal UUID |
| unit_code | Unique blood unit/bag identifier |
| facility_id | Current facility |
| donation_id | Source donation |
| component_id | Component type |
| blood_group_id | Blood group |
| collection_date | Collection date |
| processing_date | Processing date |
| expiry_date | Expiry date |
| volume_ml | Unit volume |
| status | Current inventory state |
| storage_location_id | Physical storage location |
| reserved_for_request_id | Associated request if reserved |
| received_at | Inventory entry time |
| created_at | Creation timestamp |

Recommended statuses:

```text
AVAILABLE
RESERVED
DISPATCHED
IN_TRANSIT
RECEIVED
ISSUED
RETURNED
WASTED
EXPIRED
QUARANTINED
```

---

# 10. Why Unit-Level Inventory Is Important

Suppose:

```text
O+ PRBC = 120 units
```

A basic system only knows:

> 120 available.

BloodLink needs to know:

```text
120 total

├── 90 available
├── 15 reserved
├── 10 expiring within 7 days
└── 5 quarantined
```

This enables:

- Expiry prediction
- Wastage analysis
- Accurate availability
- Reservation
- Transfer tracking
- Emergency allocation
- Stock-out prediction
- FIFO/FEFO-style inventory operations

The aggregate dashboard numbers can then be calculated from the underlying units.

---

# 11. Storage Locations

## `storage_locations`

A facility may contain multiple refrigerators, freezers, shelves, or other storage areas.

| Field | Purpose |
|---|---|
| id | Primary identifier |
| facility_id | Parent facility |
| name | Location name |
| type | Refrigerator / freezer / etc. |
| temperature_min | Minimum supported temperature |
| temperature_max | Maximum supported temperature |
| capacity | Storage capacity |
| status | Operational status |

Example:

```text
Centre A
│
├── Refrigerator R1
│     ├── Shelf A
│     ├── Shelf B
│     └── Shelf C
│
└── Freezer F1
      ├── Shelf A
      └── Shelf B
```

---

# 12. Donors

## `donors`

Donors represent people who can potentially contribute blood/components.

| Field | Purpose |
|---|---|
| id | Primary identifier |
| user_id | Optional linked user |
| name | Donor name |
| blood_group_id | Blood group |
| DOB | Date of birth |
| phone | Contact |
| email | Optional |
| city | Location |
| latitude | Approximate location |
| longitude | Approximate location |
| availability_status | Current availability |
| last_donation_date | Latest donation |
| total_donations | Donation count |
| status | Active / deferred / inactive |

The platform should avoid storing unnecessary medical information.

Actual medical eligibility and screening remain the responsibility of the authorized blood centre.

---

# 13. Donations

A donation and an inventory unit are not the same entity.

One donation can produce multiple components.

Example:

```text
DONATION001
     │
     ├── PRBC
     ├── Plasma
     └── Platelet component
```

## `donations`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| donor_id | Donor |
| facility_id | Collection facility |
| donation_type | Whole blood / apheresis etc. |
| donation_date | Date |
| volume_ml | Collection volume |
| screening_status | Screening result |
| eligibility_status | Eligibility result |
| deferral_reason | Optional |
| camp_id | Optional |
| created_at | Timestamp |

---

# 14. Donation Components

## `donation_components`

Connects one donation to the components produced.

| Field | Purpose |
|---|---|
| id | Primary identifier |
| donation_id | Source donation |
| component_id | Component produced |
| inventory_unit_id | Resulting inventory unit |
| processing_date | Processing date |
| processing_status | Processing state |

Relationship:

```text
DONATION
   │
   ├──────────┐
   ▼          ▼
 PRBC       PLASMA
   │          │
   ▼          ▼
UNIT001    UNIT002
```

---

# 15. Requests

Requests can originate from:

```text
Hospital
Ambulance
Clinic
Nursing Home
Patient / Attendant
Emergency Provider
```

## `requests`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| requester_user_id | User who created request |
| requester_facility_id | Requesting facility |
| request_type | emergency / routine / bulk |
| urgency | critical / high / normal |
| required_by | Required deadline |
| patient_reference | Internal case reference |
| verification_status | Verification state |
| status | Current request status |
| notes | Additional information |
| created_at | Creation timestamp |

---

# 16. Request Items

A request may contain multiple blood/component requirements.

## `request_items`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| request_id | Parent request |
| blood_group_id | Required blood group |
| component_id | Required component |
| quantity_requested | Requested quantity |
| quantity_fulfilled | Fulfilled quantity |
| urgency | Item urgency |
| required_by | Item deadline |

Example:

```text
REQUEST #1001

├── O− PRBC → 4 units
└── O− Platelets → 2 units
```

---

# 17. Request Allocations

This connects an actual inventory unit to a request.

## `request_allocations`

```text
id
request_item_id
inventory_unit_id
allocated_at
allocated_by
status
```

Example:

```text
Emergency Request
       │
       ▼
O− PRBC × 2
       │
       ▼
AI Source Ranking
       │
       ▼
Centre A
       │
       ├── UNIT1001
       └── UNIT1007
```

This gives BloodLink traceability from request → allocated unit.

---

# 18. Transfers

Transfers handle redistribution between facilities.

## `transfers`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| source_facility_id | Sending facility |
| destination_facility_id | Receiving facility |
| initiated_by | Initiating user |
| approved_by | Approving user |
| status | Transfer status |
| reason | Reason for transfer |
| requested_at | Request timestamp |
| dispatched_at | Dispatch timestamp |
| received_at | Receipt timestamp |

Possible statuses:

```text
PROPOSED
APPROVED
IN_TRANSIT
RECEIVED
REJECTED
CANCELLED
```

---

# 19. Transfer Items

A transfer can contain multiple blood units.

## `transfer_items`

```text
transfer_id
inventory_unit_id
component_id
quantity
```

Example:

```text
TRANSFER001

Centre B
   │
   ├── O− PRBC UNIT001
   ├── O− PRBC UNIT002
   ├── O− PRBC UNIT003
   ├── O− PRBC UNIT004
   └── O− PRBC UNIT005
          │
          ▼
Centre A
```

---

# 20. Predictions

Predictions store outputs generated by BloodLink's AI models.

Do not store only:

```text
prediction = 75
```

The database needs to preserve the context of the prediction.

## `predictions`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| facility_id | Target facility |
| component_id | Component |
| blood_group_id | Blood group |
| prediction_type | demand / shortage / expiry / procurement |
| prediction_horizon | 7 / 14 / 30 days etc. |
| predicted_quantity | Forecast |
| confidence_score | Model confidence |
| predicted_shortage_date | Optional |
| recommended_quantity | AI recommendation |
| recommendation_type | Action recommendation |
| explanation | Human-readable reason |
| model_version | Model version |
| generated_at | Generation timestamp |

Example:

```text
Facility: Centre A
Component: PRBC
Blood Group: O−

Forecast:
5.2 units/day

Current usable stock:
18

Predicted shortage:
~3 days

Recommendation:
Procure 25 units

Confidence:
0.87

Model:
demand-v2.1
```

---

# 21. Alerts

Predictions and operational events can generate alerts.

## `alerts`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| organization_id | Target organization |
| facility_id | Optional facility |
| alert_type | shortage / expiry / emergency / donor / transfer |
| severity | critical / high / medium / low |
| title | Alert title |
| message | Explanation |
| source_prediction_id | Related prediction |
| status | unread / acknowledged / resolved |
| created_at | Creation timestamp |
| resolved_at | Resolution timestamp |

Example:

```text
CRITICAL

O− PRBC shortage predicted

Estimated shortage:
48 hours

Recommended action:
Review procurement / redistribution
```

---

# 22. Donor Activation

Donor activation should be separate from generic alerts.

## `donor_activations`

| Field | Purpose |
|---|---|
| id | Primary identifier |
| prediction_id | Triggering prediction |
| facility_id | Requesting/activating facility |
| blood_group_id | Required blood group |
| component_id | Required component |
| units_needed | Additional supply required |
| target_donor_count | Target donor pool |
| status | Activation status |
| created_at | Timestamp |

A future table can track individual recipients:

## `donor_activation_recipients`

```text
activation_id
donor_id
notification_status
response
responded_at
```

Example:

```text
100 donors contacted
        ↓
22 responded
        ↓
12 eligible
        ↓
8 donated
        ↓
8 units added
```

This can later become useful feedback data for the donor-activation AI.

---

# 23. Transactions

Transactions represent changes to the operational state.

## `transactions`

Recommended transaction types:

```text
DONATION_RECEIVED
COMPONENT_CREATED
INVENTORY_ADDED
INVENTORY_RESERVED
INVENTORY_RELEASED
INVENTORY_ISSUED
INVENTORY_RETURNED
TRANSFER_DISPATCHED
TRANSFER_RECEIVED
INVENTORY_WASTED
INVENTORY_EXPIRED
PROCUREMENT_RECEIVED
REQUEST_FULFILLED
```

Example:

```text
UNIT001

10:30 → INVENTORY_ADDED
12:10 → RESERVED
13:20 → DISPATCHED
13:55 → RECEIVED
14:10 → ISSUED
```

This creates a complete lifecycle history.

---

# 24. Audit Logs

Operational transactions and security auditing should be separate.

## `audit_logs`

```text
id
user_id
organization_id
action
entity_type
entity_id
old_value
new_value
timestamp
ip_address
```

Example:

```text
User: Blood Bank Admin
Action: Approved Transfer
Entity: Transfer T001

Old status: proposed
New status: approved
```

---

# 25. Compatibility Rules

BloodLink's AI source-ranking system needs structured compatibility information.

## `compatibility_rules`

```text
id
donor_blood_group_id
recipient_blood_group_id
component_id
compatible
priority
```

Example:

```text
O− → O− PRBC = compatible
O+ → O− PRBC = not compatible
```

Clinical compatibility rules should be validated and configurable rather than generated by the AI itself.

---

# 26. Complete Relationship Model

```text
                         ORGANIZATION
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
                FACILITIES             USERS
                    │                   │
                    │                   ▼
                    │                 ROLES
                    │
          ┌─────────┼────────────┐
          │         │            │
          ▼         ▼            ▼
      INVENTORY   REQUESTS      DONORS
          │         │            │
          │         ▼            ▼
          │    REQUEST_ITEMS   DONATIONS
          │         │            │
          │         ▼            ▼
          │   REQUEST_ALLOC. DONATION_COMPONENTS
          │
          ▼
     INVENTORY_UNITS
          │
          ├───────────────┐
          ▼               ▼
      TRANSFERS       TRANSACTIONS
          │
          ▼
    TRANSFER_ITEMS


              AI LAYER
                 │
        ┌────────┴────────┐
        ▼                 ▼
   PREDICTIONS          ALERTS
        │
        ▼
 DONOR_ACTIVATIONS
```

---

# 27. Key Relationships

## Organization → Facility

```text
1 Organization
      ↓
Many Facilities
```

## Facility → Inventory

```text
1 Facility
      ↓
Many Inventory Units
```

## Donation → Components

```text
1 Donation
      ↓
Many Donation Components
```

## Component → Inventory

```text
1 Component Type
      ↓
Many Inventory Units
```

## Request → Request Items

```text
1 Request
      ↓
Many Request Items
```

## Request Item → Inventory Units

```text
1 Request Item
      ↓
Many Allocated Units
```

## Facility → Predictions

```text
1 Facility
      ↓
Many Predictions
```

## Prediction → Alerts

```text
1 Prediction
      ↓
0..Many Alerts
```

## Transfer → Inventory Units

```text
1 Transfer
      ↓
Many Inventory Units
```

---

# 28. Example End-to-End Data Flow

The database must support the complete BloodLink workflow.

## Step 1 — Donation

```text
DONOR001
Blood Group: O−
        ↓
DONATION001
```

## Step 2 — Processing

```text
DONATION001
     │
     ├── PRBC
     ├── Plasma
     └── Platelet component
```

## Step 3 — Inventory

```text
UNIT001 → O− PRBC
UNIT002 → O− Plasma
UNIT003 → O− Platelets
```

## Step 4 — Consumption

```text
UNIT001 → ISSUED
```

A transaction is created.

## Step 5 — AI Prediction

Historical transactions + current inventory + requests are analyzed.

```text
Current usable stock: 18
Predicted consumption: 5.2/day
Predicted shortage: ~3 days
```

## Step 6 — AI Recommendation

```text
recommendation_type = PROCUREMENT
recommended_quantity = 25
```

## Step 7 — Alert

```text
CRITICAL
O− shortage predicted within 3 days
```

## Step 8 — Network Optimization

AI discovers:

```text
Centre A → 4 O−
Centre B → 32 O−
```

AI proposes a transfer.

## Step 9 — Human Approval

Authorized administrator approves the transfer.

## Step 10 — Inventory Movement

```text
Centre B
UNIT100
   ↓
TRANSFER_DISPATCHED
   ↓
IN_TRANSIT
   ↓
Centre A
   ↓
TRANSFER_RECEIVED
```

## Step 11 — AI Recalculation

BloodLink recalculates:

```text
New stock
      ↓
New coverage
      ↓
New shortage risk
      ↓
New recommendation
```

This completes the closed AI loop.

---

# 29. AI Data Requirements

The database must preserve historical operational data because the AI needs it for forecasting and optimization.

Example:

```text
DATE       FACILITY   GROUP   COMPONENT   OPENING   ISSUED   RECEIVED   CLOSING
01-09      Centre A   O+      PRBC          120       10        5        115
02-09      Centre A   O+      PRBC          115       12        0        103
03-09      Centre A   O+      PRBC          103        8       10        105
```

This allows the AI to learn:

```text
Historical consumption
        ↓
Demand forecast
        ↓
Stock-out probability
        ↓
Procurement requirement
```

Therefore:

> **Transactions are not only for record keeping. They are one of BloodLink's most important AI data sources.**

---

# 30. MVP vs Future Schema

We should not implement every possible table during the hackathon.

## Tier 1 — MVP

```text
organizations
facilities
users
roles
user_roles

blood_groups
components
inventory_units

donors
donations
donation_components

requests
request_items
request_allocations

transfers
transfer_items

predictions
alerts

transactions
```

## Tier 2 — If Time Allows

```text
storage_locations
donor_activations
audit_logs
compatibility_rules
```

## Tier 3 — Production/Future

```text
notification_preferences
cold_chain_events
procurement_orders
procurement_items
blood_camps
screening_records
quality_control_records
transport_tracking
model_metrics
AI_feedback
```

---

# 31. Recommended Database Technology

## PostgreSQL

PostgreSQL is the recommended database for BloodLink.

Reasons:

- Strong relational model
- Foreign keys and constraints
- Transactions
- Complex queries
- Time-series-style operational data
- JSONB for flexible AI metadata
- Good support for geospatial extensions
- Strong fit for healthcare-style relational data

## Prisma

Recommended ORM:

```text
Node.js
   ↓
Prisma
   ↓
PostgreSQL
```

The actual `schema.prisma` should be created in the next step after the ERD and relationships are finalized.

---

# 32. Data Architecture Principle

BloodLink's database should separate four kinds of information.

### 1. Current State

> What exists now?

Examples:

```text
Current inventory
Current request status
Current donor status
```

### 2. Historical Events

> What happened?

Examples:

```text
Donation
Issue
Transfer
Wastage
Request fulfillment
```

### 3. AI Predictions

> What is likely to happen?

Examples:

```text
Future demand
Stock-out risk
Expiry risk
Predicted shortage date
```

### 4. AI Recommendations

> What should potentially happen next?

Examples:

```text
Procure
Don't procure
Redistribute
Activate donors
Use source A instead of source B
```

Sensitive operational actions remain subject to appropriate human authorization.

---

# 33. Final Conceptual Data Model

```text
                         ┌──────────────────┐
                         │   ORGANIZATIONS   │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │    FACILITIES    │
                         └────────┬─────────┘
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
             ▼                    ▼                    ▼
          USERS                DONORS             INVENTORY
             │                    │                    │
             │                    ▼                    ▼
             │                DONATIONS          INVENTORY UNITS
             │                    │                    │
             │                    ▼                    │
             │          DONATION COMPONENTS           │
             │                                         │
             └────────────────┬────────────────────────┘
                              │
                              ▼
                          REQUESTS
                              │
                              ▼
                       REQUEST ITEMS
                              │
                              ▼
                     REQUEST ALLOCATIONS
                              │
                              ▼
                         TRANSFERS
                              │
                              ▼
                      TRANSACTION LEDGER
                              │
                              ▼
                     ┌─────────────────┐
                     │   BLOODLINK AI  │
                     └────────┬────────┘
                              │
                  ┌───────────┼───────────┐
                  ▼           ▼           ▼
             PREDICTIONS    ALERTS    RECOMMENDATIONS
                  │
                  ▼
            DONOR ACTIVATION
                  │
                  ▼
               NEW DATA
                  │
                  └──────────→ AI
```

---

# 34. Final Step 3 Summary

The BloodLink database should ultimately support:

```text
Organizations
    ↓
Facilities
    ↓
Users / Roles

Donors
    ↓
Donations
    ↓
Components
    ↓
Inventory Units

Requests
    ↓
Allocations
    ↓
Fulfillment

Transfers
    ↓
Network Redistribution

Transactions
    ↓
Historical Data

Predictions
    ↓
Alerts
    ↓
Recommendations
    ↓
Human Action
    ↓
Updated Data
    ↓
AI Recalculation
```

### Core principle

> **BloodLink does not store only "how much blood exists." It stores the lifecycle of blood, the movement of blood, the demand for blood, the predictions about future blood requirements, and the actions taken in response.**

---

## Step 3 Completion Checklist

- [x] Organizations identified
- [x] Facilities identified
- [x] Users and roles identified
- [x] Blood groups identified
- [x] Blood components identified
- [x] Unit-level inventory model defined
- [x] Donor model defined
- [x] Donation lifecycle defined
- [x] Request model defined
- [x] Request allocation model defined
- [x] Transfer model defined
- [x] Prediction model defined
- [x] Alert model defined
- [x] Donor activation model defined
- [x] Transaction ledger defined
- [x] Audit model defined
- [x] Compatibility rules identified
- [x] MVP scope separated from future scope
- [x] AI data requirements identified
- [x] PostgreSQL selected as recommended database
- [x] Prisma selected as recommended ORM

---

# Next Step

## Step 4 — ERD + Actual PostgreSQL Schema

The next step will convert this conceptual model into the implementation-level design:

```text
Conceptual Data Model
        ↓
Entity Relationship Diagram
        ↓
Primary Keys
        ↓
Foreign Keys
        ↓
Cardinalities
        ↓
Enums
        ↓
Constraints
        ↓
Indexes
        ↓
PostgreSQL Schema
        ↓
Prisma schema.prisma
```

**Do not start backend implementation until Step 4 is finalized.**
