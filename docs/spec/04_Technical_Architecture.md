# BloodLink AI — Step 4: Technical Architecture

**Project:** BloodLink AI  
**Step:** 4 — Technical Architecture  
**Status:** Finalized recommended architecture  
**Primary goal:** Build a technically credible healthcare AI platform without unnecessary complexity.

---

# 1. Architecture Philosophy

BloodLink should **not** be built as a complicated enterprise microservice system for the hackathon.

We want an architecture that is:

- Simple enough for AI coding tools to implement
- Easy for the team to understand
- Easy to debug
- Fast to prototype
- Scalable enough for the proposed MVP
- Capable of supporting AI/ML, maps, notifications, and external integrations

The core architecture is:

```text
React
   ↓
Node.js + Express
   ↓
Supabase PostgreSQL
   ↕
Python AI Service

        ↕
Maps / Notifications / External APIs
```

The key design principle is:

> **Use one main application backend and one dedicated Python AI service instead of many microservices.**

---

# 2. Recommended Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React + Vite | Web application |
| Language | TypeScript | Safer, AI-friendly development |
| UI | Tailwind CSS | Fast styling |
| Components | shadcn/ui | Dashboard components |
| Charts | Recharts | Analytics/AI dashboards |
| Backend | Node.js + Express | REST API and business logic |
| Database | Supabase PostgreSQL | Main relational database |
| Authentication | Supabase Auth | Login/session management |
| Storage | Supabase Storage | Documents/files |
| Realtime | Supabase Realtime | Live inventory/request updates |
| AI Service | Python + FastAPI | ML/AI APIs |
| ML | pandas + NumPy + scikit-learn | Initial ML implementation |
| Maps | Google Maps Platform | Distance, routes, ETA |
| Notifications | Firebase Cloud Messaging | Push notifications |
| Integrations | REST API adapters | e-RaktKosh and future systems |
| Frontend deployment | Vercel | React hosting |
| Backend/AI deployment | Render/Railway | Node/Python services |

---

# 3. Overall Architecture

```text
                         BLOODLINK AI
                              │
                              ▼
                    ┌───────────────────┐
                    │   React Frontend  │
                    │     + Vite        │
                    │ Tailwind + shadcn │
                    └─────────┬─────────┘
                              │
                         REST / JSON
                              │
                              ▼
                    ┌───────────────────┐
                    │   Node.js Backend │
                    │     Express.js    │
                    └─────────┬─────────┘
                              │
              ┌───────────────┼────────────────┐
              │               │                │
              ▼               ▼                ▼
       ┌────────────┐  ┌──────────────┐  ┌──────────────┐
       │ Supabase   │  │  AI Service  │  │ External APIs│
       │ PostgreSQL │  │ Python/FastAPI│  │              │
       └────────────┘  └───────┬──────┘  └──────┬───────┘
                                │                │
                                ▼                ▼
                         ┌─────────────┐   ┌─────────────┐
                         │ ML Models   │   │ Maps / e-   │
                         │ Forecasting │   │ RaktKosh /  │
                         │ Ranking     │   │ other APIs  │
                         └─────────────┘   └─────────────┘

                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
             Google Maps             FCM
             Routes / ETA        Notifications
```

---

# 4. Why This Architecture?

Instead of:

```text
Frontend
 ↓
API Gateway
 ↓
Auth Service
 ↓
User Service
 ↓
Inventory Service
 ↓
Request Service
 ↓
Notification Service
 ↓
AI Service
 ↓
Message Queue
 ↓
Database Cluster
```

we use:

```text
React
 ↓
Express
 ↓
Supabase
 ↕
Python AI
```

This dramatically reduces:

- Infrastructure configuration
- Deployment complexity
- Debugging effort
- Number of repositories
- Number of APIs
- Number of failure points

The architecture remains modular because the AI service and external integrations are separated logically.

---

# 5. Frontend Architecture

## React + Vite

The main user interface will be built using:

```text
React
Vite
TypeScript
```

React is responsible for:

- Dashboards
- Inventory screens
- Emergency requests
- Transfer management
- Donor interface
- AI insights
- Alerts
- Maps
- Analytics

Vite provides the frontend development/build environment.

---

# 6. UI Architecture

Use:

```text
Tailwind CSS
+
shadcn/ui
```

This makes it easier to create professional dashboards without building every component from scratch.

Potential UI components:

```text
Cards
Tables
Forms
Dialogs
Tabs
Dropdowns
Badges
Alerts
Charts
Sidebars
Navigation
```

Example:

```text
┌──────────────────────────────────────────────┐
│ BloodLink AI                    🔔  Profile │
├────────────┬─────────────────────────────────┤
│ Dashboard  │                                 │
│ Inventory  │       AI INSIGHTS               │
│ Requests   │                                 │
│ Transfers  │  O− PRBC shortage predicted    │
│ Donors     │                                 │
│ AI         │  Recommended action:            │
│ Analytics  │  Transfer 5 units               │
└────────────┴─────────────────────────────────┘
```

---

# 7. Frontend Project Structure

```text
frontend/
│
├── src/
│   ├── components/
│   │   ├── ui/
│   │   ├── charts/
│   │   ├── maps/
│   │   └── inventory/
│   │
│   ├── pages/
│   │   ├── Dashboard/
│   │   ├── Inventory/
│   │   ├── Requests/
│   │   ├── Transfers/
│   │   ├── Donors/
│   │   ├── Predictions/
│   │   └── Alerts/
│   │
│   ├── layouts/
│   │   ├── DashboardLayout/
│   │   └── AuthLayout/
│   │
│   ├── services/
│   │   ├── api.ts
│   │   ├── auth.ts
│   │   └── maps.ts
│   │
│   ├── hooks/
│   ├── types/
│   └── App.tsx
│
├── package.json
└── vite.config.ts
```

The structure should remain simple; unnecessary abstraction should be avoided.

---

# 8. Backend Architecture

## Node.js + Express

The Express backend is the **main application server**.

```text
React
  ↓
HTTP Request
  ↓
Express API
  ↓
Business Logic
  ↓
Supabase PostgreSQL
```

The backend is responsible for application rules and coordination.

---

# 9. Backend Responsibilities

## Authentication

```text
User
 ↓
API
 ↓
Token verification
 ↓
Authorization
```

## Organizations

```text
Create organization
Update organization
Get organization
Manage facilities
```

## Inventory

```text
Add unit
Reserve unit
Release unit
Issue unit
Receive unit
Transfer unit
```

## Requests

```text
Create request
Verify request
Allocate inventory
Fulfill request
```

## Donors

```text
Create donor
Update donor
View donation history
Trigger activation
```

## Transfers

```text
Create transfer
Approve transfer
Dispatch
Receive
```

## AI orchestration

```text
Request prediction
Store prediction
Generate alert
Store recommendation
```

---

# 10. REST API Structure

The backend should use a simple REST API.

```text
/api/auth

/api/organizations
/api/facilities
/api/users

/api/inventory
/api/components
/api/blood-groups

/api/donors
/api/donations

/api/requests
/api/allocations

/api/transfers

/api/predictions
/api/alerts

/api/ai
```

Example endpoints:

```text
GET    /api/inventory
POST   /api/inventory
PATCH  /api/inventory/:id

GET    /api/requests
POST   /api/requests
PATCH  /api/requests/:id

GET    /api/transfers
POST   /api/transfers
PATCH  /api/transfers/:id

GET    /api/predictions
POST   /api/ai/forecast
```

---

# 11. Database Architecture

## Supabase PostgreSQL

The recommended database platform is:

```text
Supabase
│
├── PostgreSQL
├── Auth
├── Storage
└── Realtime
```

This means we don't need to separately build:

```text
Authentication infrastructure
File storage infrastructure
Realtime infrastructure
Database hosting
```

The relational model from Step 3 will live inside PostgreSQL.

---

# 12. Authentication

Use:

```text
Supabase Auth
```

For the MVP:

```text
Email + Password
```

Potential future authentication:

```text
Phone OTP
Google Login
Hospital SSO
```

Authentication should remain separate from application authorization.

---

# 13. Role-Based Access Control

The backend should enforce organization and role permissions.

Example:

```text
SUPER_ADMIN
      ↓
ORG_ADMIN
      ↓
BLOOD_BANK_ADMIN
      ↓
BLOOD_BANK_STAFF
      ↓
DOCTOR
      ↓
EMERGENCY_STAFF
```

A donor should not be able to:

```text
DELETE INVENTORY
APPROVE TRANSFER
APPROVE PROCUREMENT
```

Similarly, a hospital user should not automatically access another organization's inventory.

Supabase Row Level Security can help enforce organization/facility-level access.

---

# 14. AI/ML Architecture

BloodLink should use a dedicated Python service for ML.

```text
Node.js Backend
      │
      │ HTTP
      ▼
Python FastAPI
      │
      ├── Demand Forecast
      ├── Shortage Prediction
      ├── Expiry Risk
      ├── Source Ranking
      └── Donor Activation
```

The reason for separating the AI service is that:

- Node.js handles application/business logic
- Python handles ML/data processing
- Each service can evolve independently
- Python has a strong ML ecosystem

---

# 15. AI Technology Stack

Initial AI service:

```text
Python
FastAPI
pandas
NumPy
scikit-learn
```

Do not begin with complicated deep-learning infrastructure.

The first version should prioritize reliable, explainable models.

---

# 16. Initial AI Approach

## Demand Forecasting

Start with relatively simple approaches:

```text
Historical consumption
+
Moving averages
+
Time-based features
+
scikit-learn model
```

More advanced models can be evaluated later if the dataset supports them.

---

## Shortage Prediction

Use:

```text
Current usable stock
+
Consumption rate
+
Predicted demand
+
Pending requests
+
Incoming supply
```

to calculate future stock-out risk.

---

## Expiry Risk

Use:

```text
Expiry date
+
Current demand
+
Available quantity
+
Reserved quantity
```

to estimate the probability of wastage.

---

## Emergency Source Ranking

This does not initially need a complex ML model.

A deterministic scoring engine can rank sources using:

```text
Availability
+
Component match
+
Compatibility
+
ETA
+
Distance
+
Reserve safety
+
Urgency
```

This is easier to test and explain.

---

# 17. AI API

The Python service can expose endpoints such as:

```text
POST /predict/demand

POST /predict/shortage

POST /predict/expiry

POST /recommend/procurement

POST /recommend/redistribution

POST /recommend/source

POST /recommend/donor-activation
```

Example:

```text
POST /predict/demand
```

Input:

```json
{
  "facility_id": "F001",
  "blood_group": "O-",
  "component": "PRBC",
  "history_days": 90,
  "current_stock": 18
}
```

Output:

```json
{
  "predicted_daily_demand": 5.2,
  "shortage_in_days": 3.4,
  "recommended_quantity": 25,
  "confidence": 0.87
}
```

The Node backend stores the result in the `predictions` table.

---

# 18. AI Data Flow

```text
                 PostgreSQL
                     │
                     ▼
              Historical Data
                     │
                     ▼
              Node.js Backend
                     │
                     │ HTTP
                     ▼
             Python AI Service
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
    Forecast      Risk Model    Ranking
       │             │             │
       └─────────────┼─────────────┘
                     ▼
               Recommendation
                     │
                     ▼
              Node.js Backend
                     │
                     ▼
                PostgreSQL
                     │
                     ▼
                  Alert
                     │
                     ▼
                Dashboard
```

---

# 19. Maps Architecture

Maps are an operational component of BloodLink, not just a visual feature.

Required information:

```text
Location
Distance
Travel time
ETA
Route
```

Example:

```text
Centre A
    │
    │ 6.2 km
    │ 17 min
    ▼
Hospital
```

Google Maps Platform can be used for:

- Geocoding
- Distance
- Route calculation
- ETA
- Multi-source route comparison

The Routes API can calculate routes and route matrices between multiple origins and destinations.

---

# 20. Emergency Source Ranking with Maps

```text
Blood Centres
      │
      ├── Centre A
      ├── Centre B
      └── Centre C
      │
      ▼
Google Maps
      │
      ▼
Distance + ETA
      │
      ▼
BloodLink AI
      │
      ▼
Source Ranking
```

Example:

```text
Centre A
Distance: 4.2 km
ETA: 12 min
Stock: 8

Centre B
Distance: 8.7 km
ETA: 19 min
Stock: 25

Centre C
Distance: 15 km
ETA: 31 min
Stock: 40
```

The AI combines this information with blood compatibility, availability and network reserve.

---

# 21. Notifications

Use:

```text
Firebase Cloud Messaging
```

for push notifications.

Potential notifications:

```text
Blood shortage alert
Emergency request
Transfer approval
Transfer received
Donor activation
Request fulfillment
AI recommendation
```

Example:

```text
O− shortage predicted within 48 hours.

Recommended action:
Review redistribution or procurement.
```

---

# 22. Notification Architecture

```text
              BloodLink Backend
                     │
                Alert/Event
                     │
                     ▼
             Notification Logic
                     │
                     ▼
                    FCM
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     Hospital     Blood Bank     Donor
```

For the MVP, notification logic should remain inside the main backend rather than becoming a separate microservice.

---

# 23. External Integrations

BloodLink should have a dedicated integration layer.

```text
BloodLink Backend
       │
       ├── Maps API
       ├── Notification API
       ├── e-RaktKosh
       └── Future Healthcare APIs
```

Avoid scattering external API calls throughout the application.

Recommended structure:

```text
backend/
└── services/
    ├── maps/
    │   └── googleMapsService.ts
    │
    ├── notifications/
    │   └── fcmService.ts
    │
    └── integrations/
        └── eraktKoshService.ts
```

---

# 24. e-RaktKosh Integration

BloodLink should not position itself as a replacement for e-RaktKosh.

Instead:

```text
              e-RaktKosh
                  │
             API / Adapter
                  │
                  ▼
             BloodLink
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
 Existing ecosystem     AI intelligence
      data               & coordination
```

For the hackathon MVP:

> **Do not make the entire product dependent on live e-RaktKosh API access unless verified API credentials/documentation are available.**

Use an adapter structure:

```text
e-RaktKosh Adapter
       │
       ├── Live API
       │
       └── Mock Adapter
```

This allows the demo to work even when an external integration is unavailable.

---

# 25. File Storage

Potential organization files include:

```text
Licences
Documents
Reports
Certificates
Invoices
```

Use:

```text
Supabase Storage
```

instead of creating a custom file server.

---

# 26. Realtime Updates

Blood inventory changes frequently.

Example:

```text
O+ PRBC = 12
```

After one unit is issued:

```text
O+ PRBC = 11
```

The dashboard should update without requiring a manual refresh.

Architecture:

```text
Inventory Change
       │
       ▼
PostgreSQL
       │
       ▼
Supabase Realtime
       │
       ▼
React Dashboard
       │
       ▼
Updated Inventory
```

---

# 27. Deployment Architecture

Keep deployment simple.

```text
                    GitHub
                       │
              ┌────────┴────────┐
              ▼                 ▼
           Vercel             Render
           Frontend         Backend + AI
              │                 │
              └────────┬────────┘
                       │
                       ▼
                   Supabase
              PostgreSQL/Auth/
              Storage/Realtime
```

Alternative:

```text
Railway
```

can be used instead of Render for the backend/AI services.

---

# 28. Why Not AWS for the MVP?

AWS can absolutely be used later.

But a first version could require:

```text
EC2
RDS
S3
Cognito
Lambda
API Gateway
CloudWatch
ECS
```

This creates unnecessary infrastructure work.

For the hackathon:

```text
Vercel
+
Render/Railway
+
Supabase
```

is substantially simpler.

The architecture can later migrate to AWS, GCP or Azure if required.

---

# 29. Why Not Microservices?

Avoid:

```text
User Service
Inventory Service
Request Service
Donor Service
AI Service
Notification Service
Transfer Service
```

for the MVP.

Instead:

```text
             Express Backend
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      Inventory  Requests   Donors
          │         │         │
          └─────────┼─────────┘
                    ▼
                Transfers
                    │
                    ▼
                AI Service
```

The only separate service should initially be the Python AI service because ML/data processing naturally benefits from Python.

---

# 30. Repository Structure

Recommended repository:

```text
bloodlink-ai/
│
├── frontend/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── vite.config.ts
│
├── backend/
│   ├── src/
│   │   ├── controllers/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── middleware/
│   │   ├── utils/
│   │   └── server.ts
│   └── package.json
│
├── ai-service/
│   ├── app/
│   │   ├── models/
│   │   ├── services/
│   │   ├── routes/
│   │   └── main.py
│   ├── requirements.txt
│   └── models/
│
├── supabase/
│   ├── migrations/
│   └── seed/
│
├── docs/
│
├── .env.example
├── README.md
└── docker-compose.yml
```

---

# 31. Complete Emergency Request Flow

The most important end-to-end technical workflow:

```text
User
 │
 ▼
React
 │
 ▼
POST /api/requests
 │
 ▼
Express
 │
 ├── Verify user
 ├── Validate request
 └── Get candidate facilities
 │
 ▼
Google Maps
 │
 └── Distance / ETA
 │
 ▼
Python AI
 │
 ├── Compatibility
 ├── Availability
 ├── ETA
 ├── Reserve safety
 └── Urgency
 │
 ▼
Recommended Source
 │
 ▼
Express
 │
 ▼
PostgreSQL
 │
 ├── Create allocation
 ├── Update request
 └── Create transaction
 │
 ▼
FCM
 │
 ▼
Blood Centre Notification
 │
 ▼
Human Confirmation
 │
 ▼
Fulfillment
```

---

# 32. Complete AI Prediction Flow

```text
PostgreSQL
    │
    │ Historical inventory
    │ Consumption
    │ Requests
    │ Transfers
    │ Donations
    ▼
Node Backend
    │
    ▼
Python FastAPI
    │
    ▼
Feature Engineering
    │
    ▼
ML Model
    │
    ▼
Prediction
    │
    ├── Demand
    ├── Shortage Risk
    ├── Expiry Risk
    └── Recommended Quantity
    │
    ▼
Node Backend
    │
    ▼
predictions table
    │
    ▼
Alert / Recommendation
    │
    ▼
Dashboard
```

---

# 33. Security Architecture

For the MVP, implement:

```text
HTTPS
+
Supabase Auth
+
JWT
+
Role-Based Access
+
Row Level Security
+
Environment Variables
+
Server-side API keys
```

Never expose sensitive credentials inside React.

Examples:

```text
Google Maps secret key
FCM server credentials
AI API keys
Supabase service-role key
```

must remain on the server.

---

# 34. What AI Coding Tools Can Build Easily

### Easy

```text
React dashboard
Tailwind UI
Express REST APIs
CRUD operations
Supabase queries
Authentication
Forms
Tables
Charts
```

### Moderate

```text
Inventory allocation
Transfer workflow
Realtime updates
Google Maps integration
FCM notifications
```

### More difficult

```text
Demand forecasting
Network optimization
Production healthcare interoperability
Regulatory-grade security
```

The difficult areas should receive the most engineering attention because they are also the parts that create BloodLink's technical differentiation.

---

# 35. Final Recommended Stack

## Frontend

```text
React
Vite
TypeScript
Tailwind CSS
shadcn/ui
Recharts
```

## Backend

```text
Node.js
Express.js
TypeScript
```

## Database / Platform

```text
Supabase
PostgreSQL
Supabase Auth
Supabase Storage
Supabase Realtime
```

## AI

```text
Python
FastAPI
pandas
NumPy
scikit-learn
```

## Maps

```text
Google Maps Platform
Routes API
Geocoding API
```

## Notifications

```text
Firebase Cloud Messaging
```

## External Integrations

```text
REST API adapters
e-RaktKosh integration when API access is available
```

## Deployment

```text
Vercel → React
Render/Railway → Node + Python
Supabase → Database/Auth/Storage/Realtime
```

---

# 36. Final Architecture Diagram

```text
                         🩸 BLOODLINK AI
                              │
                              ▼
                    ┌───────────────────┐
                    │ React + Vite      │
                    │ Tailwind + shadcn │
                    └─────────┬─────────┘
                              │
                         REST / JSON
                              │
                              ▼
                    ┌───────────────────┐
                    │ Node.js + Express │
                    │   Main Backend    │
                    └─────────┬─────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │   Supabase   │  │ Python       │  │ External APIs│
     │ PostgreSQL   │  │ FastAPI      │  │              │
     │ Auth         │  │              │  │ Google Maps  │
     │ Storage      │  │ ML Models    │  │ Firebase FCM │
     │ Realtime     │  │ Forecasting  │  │ e-RaktKosh   │
     └──────────────┘  │ Ranking      │  └──────────────┘
                       │ Optimization │
                       └──────┬───────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
              pandas/NumPy        scikit-learn
```

---

# 37. Final Architecture Principle

> **BloodLink AI = React frontend → Express application backend → Supabase PostgreSQL → Python AI service → Maps/Notifications/External integrations.**

The system intentionally avoids unnecessary microservices and complex infrastructure while still supporting:

- Multi-organization healthcare workflows
- Unit-level inventory
- Emergency coordination
- AI forecasting
- AI recommendations
- Network redistribution
- Donor activation
- Geospatial source ranking
- Real-time dashboards
- Push notifications
- External healthcare integrations

---

# 38. Step 4 Completion Checklist

- [x] Frontend framework selected
- [x] UI framework selected
- [x] Backend framework selected
- [x] Database platform selected
- [x] Authentication selected
- [x] Storage selected
- [x] Realtime architecture defined
- [x] AI/ML service architecture defined
- [x] Initial ML stack selected
- [x] Maps integration defined
- [x] Notification system defined
- [x] External integration layer defined
- [x] e-RaktKosh integration strategy defined
- [x] Deployment strategy defined
- [x] Security architecture defined
- [x] Repository structure defined
- [x] Emergency request architecture defined
- [x] AI prediction architecture defined
- [x] MVP complexity intentionally minimized

---

# Next Step

## Step 5 — AI/ML Architecture

Next we need to define the intelligence itself:

```text
Data
 ↓
Features
 ↓
AI Models
 ↓
Predictions
 ↓
Scoring / Optimization
 ↓
Recommendations
 ↓
Human Approval
 ↓
Action
 ↓
New Data
```

We will determine exactly:

- Demand forecasting model
- Shortage prediction
- Expiry/wastage prediction
- Emergency source-ranking algorithm
- Network redistribution algorithm
- Procurement recommendation engine
- Donor activation model
- Explainable AI
- Model inputs/outputs
- Training data requirements
- Evaluation metrics
- How AI integrates with the PostgreSQL database
