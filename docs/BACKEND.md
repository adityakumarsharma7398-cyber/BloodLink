# BloodLink backend — foundation guide (Phase 6)

Scope of this phase: infrastructure only. The only business-facing endpoints are
`GET /api/auth/me`, `GET /api/blood-groups`, `GET /api/components`, plus the read-only inventory endpoints (Phase 7, below).
Health endpoints: `GET /api/health`, `/api/health/ready`, `/api/health/dependencies`.

## Security boundary

```
Frontend → Backend API → Authentication → Authorization → Service → Repository / DB → Supabase PostgreSQL
```

- The backend connects to PostgreSQL as the database owner role, which **bypasses RLS**. Backend
  authentication and authorization are therefore mandatory, not a convenience. RLS protects only
  direct browser access and Realtime.
- The browser never receives `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `DIRECT_URL` or
  `AI_SERVICE_API_KEY`, and never writes BloodLink tables. Only `VITE_*` values reach it.
- Every route is registered through `createSecureRouter`, which refuses a route without an explicit
  policy (`public`, `authenticated`, `anyRole`). Deny by default.

## Authentication flow

1. The browser signs in with Supabase Auth (publishable key) and sends `Authorization: Bearer <jwt>`.
2. `TokenVerifier` (Supabase implementation, `auth.getClaims()`) verifies signature/expiry. It requires
   `role = authenticated`, rejects anonymous sessions and non-UUID subjects. The token proves **identity only**.
3. `createAuthContextLoader` loads `public.users` and the user's role grants from the BloodLink database:
   user must exist and be `ACTIVE`; the organization must be `VERIFIED`/`ACTIVE`; grants count only while
   their organization is active and belong to the user's own organization.
4. `req.auth` = user, organization, grants, accessible facilities. Nothing is read from token claims or
   from frontend-supplied organization/facility/role values.

| Outcome | Status / code |
|---|---|
| Missing / malformed / invalid / expired token | 401 `UNAUTHENTICATED` |
| Valid token, no BloodLink user | 403 `USER_NOT_PROVISIONED` |
| User not ACTIVE | 403 `USER_INACTIVE` |
| Organization not active | 403 `ORGANIZATION_INACTIVE` |
| Auth provider unavailable | 503 |

The context is loaded on every request (no cache), so revoking a role or suspending a user takes effect immediately.

## Authorization flow

Pure functions in `src/authz/permissions.ts`, enforced by `src/authz/policy.ts`:
`requireAuth`, `requireRole`, `requireAnyRole`, organization- and facility-scope assertions.
The ten roles are the existing ones (SUPER_ADMIN, ORG_ADMIN, HOSPITAL_STAFF, DOCTOR, EMERGENCY_STAFF,
BLOOD_BANK_ADMIN, BLOOD_BANK_STAFF, INVENTORY_MANAGER, DONOR, PUBLIC_REQUESTER).

- SUPER_ADMIN is not a wildcard: it is a platform role and does not grant organization/facility data access.
- DONOR and PUBLIC_REQUESTER are SELF roles: they never confer organization or facility access.
- ORG_ADMIN covers all facilities of its own organization only.
- Cross-organization access is denied; a foreign organization/facility is answered as forbidden.

## Backend / database boundary

- Prisma 7 singleton (`src/db/client.ts`) over `DATABASE_URL` with `@prisma/adapter-pg`; SSL per `DATABASE_SSL`.
- `withTransaction(fn)` runs a business mutation and its audit record in **one** transaction.
- `callPrivate(db, name, args)` is the only way to call the `private.*` functions (status machine, holds,
  transfers, audit). It uses an allow-list registry (`src/db/privateFunctions.ts`), validates every argument, and
  binds values as parameters. A test compares the registry with the live `pg_proc` catalog.
- No new tables, no migration changes. The database keeps enforcing its own rules; the backend maps its errors.
- `AuditService.record(tx, entry)` calls `private.write_audit` and refuses to run outside a transaction.
  **Known limitation:** `private.write_audit` has no IP parameter, so `audit_logs.ip_address` stays NULL. The
  client IP is captured in the request context and written to the structured `audit` log line with the same
  correlation id. Populating the column requires a migration (optional `p_ip`) and needs approval.

## Supabase client boundaries

| Client | Key | Used for |
|---|---|---|
| Browser | publishable key | Auth sign-in only; no table access |
| Token verifier (backend) | publishable key | `auth.getClaims()` only |
| Admin client (backend) | service role | Reserved for Auth Admin operations; currently unused; never for data |

## Environment configuration

`src/config/env.ts` validates the environment (`parseConfig`, pure). Errors name variables, never values.
Only `loadRuntimeConfig()` reads `.env`, and it skips dotenv under tests. Optional integrations
(Google Maps, FCM, e-RaktKosh live) are required only when their provider is selected.
Production requires `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `AI_SERVICE_API_KEY` and refuses
`DATABASE_SSL=disable`, wildcard CORS and `ALLOW_DEMO_COMPATIBILITY_RULES=true`. See `.env.example`.

## API conventions

- Success: `{ "data": ... }` (lists also carry `pagination`). Error:
  `{ "error": { "code", "message", "details"?, "requestId" } }`.
- Database, Prisma and body-parser errors map to fixed generic messages; no SQL, stack, host or credential is ever returned.
  BloodLink's own function errors keep stable business codes (e.g. `INVALID_UNIT_TRANSITION`).
- Every response carries `X-Request-Id` (server-generated correlation id). Bodies are limited to 1 MB; requests time out.
- Reference data: `Cache-Control: public, max-age=300`. All other `/api` responses: `no-store`.
- Rate limits (`express-rate-limit`, in-memory, per instance): public routes per IP per minute; 401 responses per IP per
  15 minutes. No global limit on authenticated traffic. Failures are `429 RATE_LIMITED` with `Retry-After`.
- Health: `/health` is liveness (no DB). `/health/ready` reports 200/503 only. `/health/dependencies` gives anonymous
  callers only an overall status; per-dependency detail is for platform SUPER_ADMIN.

## Inventory (Phase 7, read-only)

| Endpoint | Purpose |
|---|---|
| `GET /api/inventory/summary` | Per facility × blood group × component: quantities and shortage/expiry status |
| `GET /api/inventory/units?facilityId=` | Unit-level view, first-expiry-first, paginated |

- **Access:** ORG_ADMIN (own organization), BLOOD_BANK_ADMIN, BLOOD_BANK_STAFF, INVENTORY_MANAGER, each at their own
  facility. Hospital roles, DONOR, PUBLIC_REQUESTER and SUPER_ADMIN get 403. A facility the caller cannot read is
  answered 404. Without `facilityId`, the summary covers only the caller's readable inventory-holding facilities.
- **Quantities:** `available` (AVAILABLE and not past expiry), `reserved`, `pendingAcceptance` (QUARANTINED/RECEIVED),
  `inTransit`, `expiringSoon`, `expiredNotYetMarked` (past expiry but the scheduled job has not run yet), `onHand`.
- **Statuses come only from configured planning parameters; the code holds no defaults.** Missing or invalid
  configuration gives `UNKNOWN` with a `reason` (`NOT_CONFIGURED`, `INVALID_PARAMETER`, `NO_CONSUMPTION_HISTORY`).

  | Key | Value | Used for |
  |---|---|---|
  | `expiry.warning_days` | positive number | expiry status `AT_RISK` / `OK` |
  | `forecast.history_days` | positive integer | look-back window for average consumption |
  | `coverage.risk_bands` | `{criticalBelowDays, highBelowDays, mediumBelowDays}`, increasing | shortage risk level |

  Days of cover = available ÷ (units ISSUED in the window ÷ window days). This is a trailing average of real
  ledger events, not a forecast. Every row echoes the parameters that produced its status.
- Parameters resolve most-specific-first (facility > organization > network, then blood group, then component). The
  TypeScript resolver is tested against `private.resolve_parameter`.
- No mutation exists, so nothing is audited; a future write endpoint must use `withTransaction` + `AuditService`.

## Demand and procurement (Phase 7, second workflow)

| Endpoint | Purpose |
|---|---|
| `POST /api/intelligence/runs {facilityId}` | Recompute demand, cover and procurement recommendations for one facility (audited) |
| `GET /api/intelligence/predictions` | Current (or historical) DEMAND / SHORTAGE predictions |
| `GET /api/intelligence/recommendations` | Procurement recommendations |
| `POST /api/intelligence/recommendations/:id/decision` | APPROVE / MODIFY / REJECT by a human; records the decision only |

- **Access:** read = inventory readers; run = ORG_ADMIN, BLOOD_BANK_ADMIN, INVENTORY_MANAGER; decide = ORG_ADMIN, BLOOD_BANK_ADMIN.
  Facilities of other organizations answer 404.
- **Demand comes from the AI service first, the trailing-average baseline as a fallback.** For each series with
  `forecast.history_days`/`forecast.horizon_days` configured, the backend sends the facility's own trailing
  `history_days` of `public.v_daily_consumption` (already zero-filled, IST calendar days — no other facility's or
  patient's data) to the Python AI service's `POST /predict/demand`
  (`ai-service/app/routes/predict.py` → `ai-service/app/services/demand_forecast.py`), which fits a linear trend
  through it (ordinary least squares; scikit-learn/numpy) and reports `predicted_daily_demand`, a confidence score
  (the fit's R², or a low, sample-size-based score when there isn't enough history to trust a trend) and its own
  `model_name`/`model_version`. **Any failure — unreachable, a non-2xx response, a timeout, or a body that fails
  validation (negative demand, a confidence outside 0–1, a missing field) — is treated exactly like "no forecast" and
  silently falls back to the unchanged baseline** (`daily demand = units ISSUED in the window / window days`); nothing
  downstream can tell the difference except the stored `model_name`/`model_version`/`confidence_score`/`confidence_method`.
  This fallback is proven by `backend/tests/api/demandForecast.test.ts`, which is the closest thing to a contract test
  between the two services.
- Everything downstream — `days of cover = (usable + incoming) / daily demand`,
  `deficit = ceil(target_days x daily demand - (usable + incoming))`, and what redistribution/donor-activation read off
  the facility's own current prediction — is **completely unchanged**; only the daily-demand number that feeds it can
  now come from a real model. `incoming` = QUARANTINED/RECEIVED units at the facility + units IN_TRANSIT on transfers
  headed to it. `pending_request_units` is not subtracted (reserved units are already excluded from usable) and
  redistribution is not considered; both are recorded in each prediction's `explanation`, along with which method
  produced it (`explanation.method`, `explanation.model`, `explanation.confidence` when present).
- **`recommendations.source` stays `SYSTEM_RULE`** even when the AI service supplied the demand figure: procurement
  quantity, redistribution source-selection and donor-activation targeting are still the same deterministic rules in
  §7.2a/§7.3 — only their demand *input* can now be a forecast rather than an average. `POST /api/intelligence/runs`
  reports `demandForecastMethods: { AI_SERVICE, BASELINE }`, a count of series decided each way, for operators.
- **Parameters (no defaults):** `forecast.history_days`, `forecast.horizon_days` (1..90), `coverage.target_days`,
  `coverage.risk_bands`. A missing one skips the series or the recommendation, and the run reports why.
- **Run semantics:** one transaction under a per-facility advisory lock: older current predictions are superseded,
  older PENDING procurement recommendations become EXPIRED, new rows are written, and `prediction.generate` is audited.
  Recommendations stay valid until the end of the forecast period.
- **Decision semantics:** row-locked; only PENDING and unexpired recommendations; MODIFY changes only `quantity` and keeps the
  original payload; MODIFY and REJECT need a note (kept out of the audit log). Nothing is ordered, no transfer is created.

## Network redistribution (Phase 7, third workflow)

| Endpoint | Purpose |
|---|---|
| `POST /api/intelligence/redistribution/runs {facilityId}` | Recommend a source and quantity for each short blood group and component (audited) |
| `GET /api/intelligence/recommendations?type=REDISTRIBUTION` | List them (also `PROCUREMENT`; both by default) |
| `POST /api/intelligence/recommendations/:id/decision` | Destination approves, lowers (MODIFY) or rejects; approving proposes a transfer |
| `GET /api/transfers`, `GET /api/transfers/:id` | Transfers visible to the source or destination facility |
| `POST /api/transfers/:id/approve` `{approvedQuantity?}` | Source BLOOD_BANK_ADMIN; runs `private.approve_transfer` |
| `POST /api/transfers/:id/reject` `{reasonCode, note?}` | Source BLOOD_BANK_ADMIN; runs `private.reject_transfer` |

- **Inputs:** the destination's own current SHORTAGE predictions (run the intelligence run first) and, for each candidate
  source, its usable units, pending request demand and its own current demand prediction. Candidates are inventory-holding,
  operational facilities of VERIFIED/ACTIVE organizations that share network availability.
- **Rule (§7.2a):** `deficit = ceil(target x demand - (usable + incoming))`, `shareable = usable - pending - ceil(reserve_floor_days x demand)`,
  `quantity = min(deficit, shareable, transfer.max_units)`, recommended only if `quantity >= transfer.min_units`.
  One source per series: largest transferable quantity, then shortest ETA, then name. Parameters (no defaults):
  `coverage.target_days`, `transfer.min_units`, `transfer.max_units`, `reserve.floor_days` (source), and optionally
  `eta.road_factor` + `eta.urban_speed_kmh` (ETA is empty unless both exist; Haversine distance as in the mock Maps adapter).
- **Privacy (U1):** the destination receives only the source identity, `source_can_fulfil`, `source_spare_units`, the ETA and
  a prediction id. The source's demand, reserve floor, exact cover and expiry dates are used inside the backend and never
  returned or stored in the destination's rows. The source organization cannot read the destination's recommendations.
  A transfer is shown identically to both sides with no unit identifiers or stock figures.
- **Human approval, two steps:** the destination decides the recommendation (MODIFY may only lower the quantity); that creates a
  PROPOSED transfer (`transfer.propose` audited for both organizations, re-checking that the source is still eligible).
  The source BLOOD_BANK_ADMIN then approves (the database picks first-expiry-first units and reserves them) or rejects.
  The database writes the audit rows for approve and reject.
- **Rejection privacy (same model as hold reasons):** `reject_transfer` copies its reason into the transfer row the destination
  reads and into both organizations' audit rows, so the backend passes it only a fixed `reasonCode` (`INSUFFICIENT_STOCK`,
  `RESERVE_REQUIRED`, `NOT_NEEDED`, `OTHER`). The source's optional free-text `note` is written by the backend to the SOURCE
  organization's audit log alone (`transfer.reject_note`); the destination sees the code only. No migration is needed.
- **Not part of this workflow:** dispatch, receipt and cancellation of transfers, and marking a recommendation EXECUTED.

## Emergency rapid fulfillment (Phase 7, fourth workflow)

Two human confirmations stand between a request and any blood leaving a source. **Nothing here dispatches, issues or
returns a unit**; those steps are outside this workflow.

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/emergency/requests` | EMERGENCY_STAFF only (own facility) | Create an emergency request, verified at creation (decision 2) |
| `GET /api/emergency/requests`, `/:id` | same | The facility's requests, with holds by source (counts and status only) |
| `POST /api/emergency/requests/:id/source-selection` | same | Rank the network sources and store a PENDING `EMERGENCY_SOURCE` recommendation |
| `POST /api/emergency/source-selections/:id/decision` | same | APPROVE (whole remaining need, default rank 1), MODIFY (lower quantity, chosen source), REJECT |
| `GET /api/emergency/incoming` | BLOOD_BANK_ADMIN, BLOOD_BANK_STAFF (source) | Holds waiting for confirmation, as minimum delivery data |
| `POST /api/emergency/holds/confirm` `{allocationIds}` | same | The source confirms; units stay reserved |
| `POST /api/emergency/holds/decline` `{allocationIds, note}` | same | The source declines; units return to stock |

- **Requesting-side role:** EMERGENCY_STAFF only, per the approved role matrix (§9.2), and only at their own facility. The
  database's own triggers (`requests_rules`, `can_act_for_request`) are broader — they also accept HOSPITAL_STAFF and DOCTOR,
  for a later routine-request workflow — but this backend narrows the emergency endpoints to EMERGENCY_STAFF only.
- **Request data:** blood group, component, quantity (1-100), urgency, required-by, and whether compatible substitutes are allowed.
  Patient details, contact numbers and free-text notes are not accepted at all (strict schema).
- **Compatibility:** decided only by the database (`private.network_availability` and `private.place_source_hold`) from
  the compatibility rules. No rule is seeded or assumed. With no usable rule the result is empty and says
  `compatibility.rulesFound = false`. When demo rules are allowed (`ALLOW_DEMO_COMPATIBILITY_RULES`, never in production) the
  response carries `COMPATIBILITY_RULES_NOT_CLINICALLY_VALIDATED`.
- **Source ranking (no weights):** can supply the whole quantity, then shortest ETA (empty unless `eta.road_factor` and
  `eta.urban_speed_kmh` exist), then most spare units above reserve, then name. Stock counts only AVAILABLE units, so units on hold are
  already excluded. A source whose reserve floor cannot be computed is not offered, and reserve floors are re-checked at decision
  time. Sources that do not accept holds or have no `allocation.hold_timeout_minutes` are listed as not selectable.
- **Privacy:** each ranked source carries only `facility_id`, `facility_name`, `can_fulfil`, `spare_units_above_reserve`,
  `near_expiry_opportunity`, `distance_km`, `eta_minutes`, `rank`. The source sees only request number, product, quantity,
  urgency, deadline, destination facility and hold state; never patient, contact, notes or requester. The requester never
  sees unit identifiers. A source's decline text stays on the source's side; the requester receives `SOURCE_DECLINED`.
- **Audit:** `request.create`, `request.select_sources`, `recommendation.approve|modify|reject` by the backend; hold audit rows by the database.
- **Not included:** public-requester (unverified) requests and their review, dispatch/issue/return, donor activation.

## Donor activation / mobilization (Phase 7, fifth workflow)

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/donor-activations/runs {facilityId}` | ORG_ADMIN, BLOOD_BANK_ADMIN, INVENTORY_MANAGER | From the facility's own current SHORTAGE prediction, estimate donors needed and store a PENDING `DONOR_ACTIVATION` recommendation |
| `GET /api/donor-activations`, `/:id` | inventory readers | List/read activations: counts by response and notification status, radius, message; donor identity only for WILLING responders |
| `GET /api/intelligence/recommendations?type=DONOR_ACTIVATION` | inventory readers | The pending/decided recommendations (shares the intelligence endpoints; same decision endpoint as procurement/redistribution) |
| `POST /api/donor-activations/:id/notify` | ORG_ADMIN, BLOOD_BANK_ADMIN | Sends the in-app notification to PENDING recipients |
| `POST /api/donor-activations/:id/cancel` | ORG_ADMIN, BLOOD_BANK_ADMIN | Stops an ACTIVE activation |
| `GET /api/donor-activations/mine` | DONOR | The caller's own recipient rows only (matched by their own donor profile, never a client-supplied id) |
| `POST /api/donor-activations/recipients/:recipientId/respond {response}` | DONOR | WILLING or DECLINED, recorded exactly once |

- **When activation is appropriate:** reuses the same deficit rule as procurement/redistribution — `deficit = ceil(coverage.target_days x daily_demand - (usable + incoming))` from the facility's current SHORTAGE prediction. A missing `coverage.target_days`, `donor.search_radius_km` or `donor.min_interval_days` skips the series with a reason; nothing is guessed.
- **Targeting, never eligibility:** candidates are donors who consent to contact, are `ACTIVE`/`AVAILABLE`, are a blood group compatible with the need (via the existing compatibility rules only — no new rule is ever added), are within `donor.search_radius_km`, and have not donated within `donor.min_interval_days`. Medical eligibility is decided by blood-centre staff at the donation itself, never here.
- **No duplicate activation of one donor:** a donor already targeted by another ACTIVE activation for the same facility/blood group/component is excluded from being selected again; the recipients table's own unique constraint is a second guard.
- **Human approval:** the recommendation only proposes a donor count (`quantity`, cappable on MODIFY, never raisable); approving/modifying is what actually creates the `donor_activations` row and its `donor_activation_recipients`, inside the same transaction as the decision, audited as `donor_activation.create`.
- **Privacy:** a recommendation and its audit rows carry counts and the radius only — never which donors. Staff reading an activation see response/notification counts only; a donor's name, phone and email appear only once that donor has responded WILLING (matches the database's own RLS rule for `donors`).
- **Notification abstraction:** `NotificationAdapter` (`src/services/notifications/notificationAdapter.ts`). The `inapp` provider (default) does not call out anywhere — marking a recipient row SENT is itself the delivery, since `donor_activation_recipients` is already in the Realtime publication and RLS lets a donor read their own row. A donor with no BloodLink account cannot be notified in-app and is recorded FAILED. The `fcm` provider is configured but not implemented yet; it fails loudly (`501 NOTIFICATION_PROVIDER_NOT_IMPLEMENTED`) rather than pretending to send a push notification.
- **Not included:** external push delivery, redesigning `donor_activations`/`donor_activation_recipients`, and any change to donor medical-eligibility rules.

## Testing approach

| Command (in `backend/`) | Tier |
|---|---|
| `npm test` | Unit: no DB, no network, stub TokenVerifier, never reads `.env` |
| `npm run test:api` | API: real Express + Prisma against a throwaway local PostgreSQL (port 54339), never hosted |
| `npm run test:db` | Database security/behaviour suite (local; read-only/rolled-back against hosted only via `DB_VERIFY_URL`) |
| `npm run test:all` | All three |

Tests never depend on hosted Supabase and leave no data there.

The backend's own AI-integration tests (`tests/api/demandForecast.test.ts`, plus unit tests for the client and the
planner) never call the real AI service — they inject a fake `AiServiceClient` (`tests/support/testApp.ts`'s
`fakeAiClient`), so they run without the Python service and are deterministic. The AI service's own tests live at
`ai-service/tests/` (`python -m pytest -q`, or `node scripts/run-ai.mjs test`) and cover the forecasting model and the
`/predict/demand` route directly, including the shared `X-Service-Key`.
