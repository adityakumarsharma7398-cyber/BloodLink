# BloodLink AI

**The intelligence layer for the blood supply network.**

BloodLink doesn't just show available blood — it predicts shortages, identifies risks, and
recommends the best action across the blood-supply network. AI predicts, ranks, recommends and
explains; authorized humans approve every sensitive action.

```
Data → Predict → Recommend → Human approval → Action → Updated data → AI recalculates
```

## Specification

The project specification lives in [`docs/`](docs/):

| File | Covers |
|---|---|
| [`docs/spec/01_Complete_Workflow_Documentation.md`](docs/spec/01_Complete_Workflow_Documentation.md) | Product, users, PLAN / OPTIMIZE / RESPOND / MOBILIZE workflows |
| [`docs/spec/03_Database_Data_Model.md`](docs/spec/03_Database_Data_Model.md) | Conceptual data model, unit-level inventory |
| [`docs/spec/04_Technical_Architecture.md`](docs/spec/04_Technical_Architecture.md) | Stack, services, integrations, security |
| [`docs/spec/05_Prototype_UI_UX.md`](docs/spec/05_Prototype_UI_UX.md) | Screens, tiers, explainability, demo story (visual style superseded by decision M) |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Approved decisions, including the revised visual direction (M) that supersedes Step 5's look |

## Architecture

```
frontend/    React + Vite + TypeScript, Tailwind CSS v4, shadcn/ui, Recharts
    │  REST /api   (+ Supabase Auth session & Realtime via anon key, RLS-protected)
backend/     Node + Express + TypeScript — the only business-logic backend
    │                         │
supabase/    Postgres, Auth,   ai-service/   Python FastAPI — pandas, NumPy, scikit-learn
             Storage, Realtime               (called only by the backend, with a shared key)
```

External integrations (Google Maps, Firebase Cloud Messaging, e-RaktKosh) sit behind adapters in
`backend/src/services/` with mock fallbacks, so the app runs with **Supabase credentials only**.

## Prerequisites

- Node.js **20.19+** (Vite 8 requirement)
- Python **3.12+** (developed on 3.14)
- A hosted Supabase project (needed from Phase 3; the foundation runs without it)

## Getting started

```bash
npm run setup
```

Installs root, frontend and backend packages, creates `ai-service/.venv` and installs the Python
requirements. Then create your environment file:

```bash
cp .env.example .env
```

Every variable is documented in [`.env.example`](.env.example). All services read this one root
`.env` locally; only `VITE_*` variables reach the browser.

```bash
npm run dev
```

Starts all three services with prefixed logs:

| Service | URL | Health |
|---|---|---|
| Frontend (Vite) | http://localhost:5173 | Landing `/`, design previews `/app`, `/emergency`, `/design`; connectivity check `/status` |
| Backend (Express) | http://localhost:4000 | `GET /api/health`, `/api/health/ready`, `/api/health/dependencies`, `/api/auth/me`, `/api/blood-groups`, `/api/components` |
| AI service (FastAPI) | http://localhost:8000 | `GET /health`, interactive docs at `/docs` |

The Vite dev server proxies `/api` to the backend, so the browser only ever talks to one origin.

## Scripts (root)

| Command | Does |
|---|---|
| `npm run dev` | Run frontend, backend and AI service together |
| `npm run dev:frontend` / `dev:backend` / `dev:ai` | Run one service |
| `npm run build` | Production build of backend (`backend/dist`) and frontend (`frontend/dist`) |
| `npm run typecheck` | TypeScript checks for backend and frontend |
| `npm run test:api` / `test:db` | Backend API tests (local PostgreSQL) / database tests |
| `npm test` | Backend (Vitest + Supertest), frontend (Vitest + Testing Library) and AI service (pytest) tests |

Backend architecture, authentication/authorization flow, the DB boundary and testing tiers: [`docs/BACKEND.md`](docs/BACKEND.md).

## Repository layout

```
├── frontend/          React app (src/components, pages, services, lib)
├── backend/           Express API (src/controllers, routes, services, middleware, utils, config)
├── ai-service/        FastAPI (app/routes, services, models, core) + models/ for artifacts
├── supabase/          migrations/ (DB source of truth) and seed/
├── scripts/           Cross-platform helpers for the Python virtualenv
├── docs/              Specification + approved decisions
└── .env.example       Every environment variable, documented
```

## Security baseline

- Secrets live only in `.env` / platform settings — never committed, never in `VITE_*` variables.
- The Supabase service-role key, Google server key and FCM credentials are backend-only.
- The AI service requires the shared `X-Service-Key` header (`AI_SERVICE_API_KEY`) on every
  prediction/recommendation endpoint.
- Express enforces organization- and role-level authorization; Supabase RLS protects direct
  client access and Realtime.

## Deployment (planned)

Vercel (frontend) · Render or Railway (backend + AI service) · Supabase (data, auth, storage, realtime).
