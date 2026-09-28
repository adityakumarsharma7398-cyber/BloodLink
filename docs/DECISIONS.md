# BloodLink AI — Approved Implementation Decisions

The specification is the set of files in [`docs/spec/`](spec/) **plus** the decisions below,
approved after the Phase 0 documentation review (2026-09-24). The spec files are kept
unchanged; `05_Prototype_UI_UX.md` is the single copy of the two identical Step 5 files
that were provided.

If a later conflict is found, it is raised for discussion — never silently resolved.

| # | Topic | Decision |
|---|---|---|
| A | Missing AI/ML + physical ERD docs | Designed from existing docs. Every important AI algorithm, threshold, scoring weight, reserve floor, confidence calculation or compatibility behaviour is documented for review **before** it is implemented. Prefer explainable, deterministic, reproducible logic and simple ML. |
| B | Prisma vs Supabase | Supabase SQL migrations (`supabase/migrations`) are the database source of truth. Prisma (introspected with `db pull`) gives typed backend access. Express enforces organization- and role-level authorization. RLS protects direct client access and Realtime. |
| C | Auth users | `auth.users` is the identity. `public.users` is a profile table keyed to `auth.users.id`. No `password_hash` column. |
| D | Roles | Independent permission sets, not a hierarchy. Many-to-many via `user_roles`. |
| E | MVP tables | `compatibility_rules`, `donor_activations`, `donor_activation_recipients` are MVP. |
| F | Recommendations | Dedicated `recommendations` table (type, org, facility, related prediction, status, payload JSON, what/why/data/action explanations, source, decided_by/at, timestamps). Statuses: `PENDING`, `APPROVED`, `MODIFIED`, `REJECTED`, `EXPIRED`, `EXECUTED`. Approving a redistribution creates a `transfers` record. |
| G | Demo narrative | Protagonist **ABC Hospital** (`HOSPITAL_BLOOD_CENTRE`); its internal blood centre is **Centre A**. The emergency request comes from a separate nearby authorized clinic/ambulance. All numbers are computed from one database state — never hard-coded. A source that cannot fulfil a request is never recommended; a critically short facility is never shown as a surplus source unless the time horizon explains it. |
| H | Supabase | Hosted Supabase project. No local Docker requirement. All variables documented in `.env.example`; secrets never committed. |
| I | Maps / notifications | Adapter architecture. Without Google credentials: mock Maps adapter with Haversine distance and a documented approximate ETA. Notifications: service abstraction, Supabase Realtime / in-app for MVP, FCM adapter ready. The app must work with Supabase credentials only. |
| J | Frontend deps | `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing`, `motion` — only where they serve the documented UI. 3D communicates, 2D operates. |
| K | Repository | Built directly in the project root; spec copied into `docs/spec/`. |
| L | Public requests | `PENDING_VERIFICATION` → staff review → `VERIFIED` → AI source matching → authorized fulfilment. No KYC. |

## Standing rules

1. **Single source of truth** — dashboards, charts, predictions, recommendations, network and emergency results all derive from the same database state.
2. **AI transparency** — no displayed number (e.g. a confidence %) unless the implemented logic produced it.
3. **Clinical safety** — compatibility comes only from `compatibility_rules` reference data and is a hard constraint in ranking.
4. **Human approval** — AI predicts, ranks, recommends and explains. It never releases blood, approves transfers or procurement, authorizes fulfilment, or declares medical eligibility.
5. **Real data flow** — the demo path runs Frontend → Backend → Database → AI → Backend → Database → Frontend.

## Visual direction revision (approved 2026-09-24)

| # | Topic | Decision |
|---|---|---|
| M | UI/UX visual language | **Supersedes the visual language of `05_Prototype_UI_UX.md`** ("dark cinematic command centre", 3D network, glass, glow, particles). BloodLink now looks like professional medical software: white / light-grey surfaces, meaningful red (≈5–10%), near-black text, blue only in rare informational cases; no purple, neon, gradients, glassmorphism, glow or 3D. 4–8px radii, thin neutral borders, minimal shadows, conventional buttons (primary red, secondary white with border), table- and form-centric operational screens, restrained motion. AI is shown through concrete outputs (prediction → reason → recommended action → human review), never "AI-powered" decoration. |

What still stands from Step 5: the screen inventory and tiering, the WHAT / WHY / DATA / ACTION explainability,
human approval of every sensitive action, mobile-first donor/emergency flows, and accessibility
(icon + text for every status, never colour alone). The 3D foundation from Phase 2 was removed.
