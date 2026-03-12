# Architecture

## System Diagram

```
                        ┌─────────────────────────────────────────────────────┐
                        │                    Browser                          │
                        │                                                     │
                        │  index.html + static/app.js + static/style.css      │
                        │                                                     │
                        │  ┌─────────────┐        ┌───────────────────────┐  │
                        │  │  Guest Mode │        │   Logged-in Mode      │  │
                        │  │             │        │                       │  │
                        │  │ localStorage│        │ Bearer token (JWT)    │  │
                        │  │ tt_guest_   │        │ GET/POST /data        │  │
                        │  │ tasks       │        │ POST /sessions/start  │  │
                        │  │             │        │                       │  │
                        │  │ Rate limit  │        │ Rate limit enforced   │  │
                        │  │ client-side │        │ server-side           │  │
                        │  └─────────────┘        └───────────────────────┘  │
                        │         │                          │                │
                        │         └──────┬───────────────────┘                │
                        │                │ BroadcastChannel('tt')             │
                        │                │ (cross-tab sync)                   │
                        └────────────────┼────────────────────────────────────┘
                                         │ HTTPS
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Fly.io  (tikkit)                                    │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        FastAPI  (app.py)                               │  │
│  │                                                                        │  │
│  │  Auth                  Data                   Billing                 │  │
│  │  ─────────────────     ──────────────────     ──────────────────────  │  │
│  │  POST /auth/signup     GET  /data             POST /billing/checkout  │  │
│  │  POST /auth/login      POST /data             GET  /billing/portal    │  │
│  │  POST /auth/google     POST /sessions/start   GET  /billing/status    │  │
│  │  POST /auth/forgot-                           POST /billing/webhook   │  │
│  │       password                                                        │  │
│  │  POST /auth/reset-     Static                                         │  │
│  │       password         ──────────────────                             │  │
│  │                        GET  /                                         │  │
│  │                        GET  /static/*                                 │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                          │                                                   │
│                          │                                                   │
│  ┌───────────────────────┼───────────────────────────────────────────────┐  │
│  │          Postgres  (titr-db)       │                                  │  │
│  │                                   │                                  │  │
│  │  users                            │                                  │  │
│  │  ├─ id, email, password_hash      │                                  │  │
│  │  ├─ stripe_customer_id            │                                  │  │
│  │  └─ subscription_status/id/end    │                                  │  │
│  │                                   │                                  │  │
│  │  tasks ──────────────── sessions  │                                  │  │
│  │  ├─ id (PK with user_id)  ├─ id   │                                  │  │
│  │  ├─ user_id (FK)          ├─ task_id + user_id (FK → tasks)          │  │
│  │  └─ name                  ├─ start_ts, end_ts (ms timestamps)        │  │
│  │                           └─ UNIQUE(task_id, user_id, start_ts)      │  │
│  │                                   │                                  │  │
│  │  later_items              user_data (legacy blob, Plan B rollback)   │  │
│  │  ├─ id, user_id (FK)      ├─ user_id (FK)                           │  │
│  │  ├─ text                  ├─ tasks_json (kept in sync)               │  │
│  │  └─ position              └─ migrated_at                            │  │
│  │                                   │                                  │  │
│  │  password_reset_tokens            │                                  │  │
│  └───────────────────────────────────┼───────────────────────────────────┘  │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       │
              ┌────────────────────────┼──────────────────────┐
              │                        │                      │
              ▼                        ▼                      ▼
      ┌──────────────┐       ┌──────────────────┐   ┌───────────────┐
      │   Stripe     │       │     Resend       │   │ Google OAuth  │
      │              │       │                  │   │               │
      │  Checkout    │       │  Password reset  │   │  Social       │
      │  Portal      │       │  emails          │   │  sign-in      │
      │  Webhooks →  │       │                  │   │               │
      │  sub status  │       │                  │   │               │
      └──────────────┘       └──────────────────┘   └───────────────┘
```

## Request Flow

### New visitor (guest)
1. Browser loads `GET /` → `index.html`
2. `app.js` checks `localStorage.tt_token` → missing → guest mode
3. Data read/written to `localStorage.tt_guest_tasks`
4. Session rate limit enforced client-side (5/day after 30-day trial)

### Logged-in user
1. Browser sends `Authorization: Bearer <jwt>` with every request
2. `current_user_id()` dependency decodes + validates the JWT
3. `GET /data` → joins `tasks` + `sessions` + `later_items`, returns JSON
4. `POST /data` → syncs full state into normalized tables (upsert/delete); also writes blob to `user_data` for rollback
5. `POST /sessions/start` → server checks session count for free users

### Guest → account conversion
1. User signs up / logs in with existing guest data
2. Frontend POSTs `localStorage.tt_guest_tasks` blob to `POST /data`
3. Clears guest localStorage key

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single JSON blob → normalized tables | Migrated on first deploy; blob kept in sync as Plan B |
| JWT in localStorage (not cookie) | Simplicity; no CSRF surface for a single-origin SPA |
| Full state sync on `POST /data` | Matches frontend mental model; simplifies conflict resolution (last write wins) |
| BroadcastChannel for tab sync | Prevents stale state across windows without a WebSocket |
| Stripe webhooks for subscription state | Source of truth for billing; status updated async on payment events |
| Fly.io auto-stop machines | Keeps cost low for low-traffic periods |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `SECRET_KEY` | JWT signing key |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `RESEND_API_KEY` | Transactional email (password reset) |
| `RESEND_FROM` | Sender address for emails |
| `APP_URL` | Base URL (used in reset links, Stripe redirects) |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `STRIPE_PRICE_ID` | Subscription price to charge |
