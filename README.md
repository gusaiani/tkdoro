# AI Time Tracker

A minimal, keyboard-driven time tracker inspired by Notational Velocity.

![tt screenshot](screenshot.png)

## Running locally

**Prerequisites:** [Postgres.app](https://postgresapp.com) running on port 5432.

Create the database (one-time):

```bash
createdb tt
```

Copy the environment template and start the server:

```bash
cp .env.example .env
uvicorn app:app --reload
```

Navigate to [http://localhost:8000](http://localhost:8000). You'll be prompted to sign up on first run.

The `.env` file is gitignored. `DATABASE_URL` and `SECRET_KEY` are loaded from it automatically on startup.

## Testing

Create the test database (one-time):

```bash
createdb tt_test
```

Install dev dependencies and run the suite:

```bash
pip install -r requirements-dev.txt
pytest
```

Tests use transaction-per-test rollback for fast, isolated runs against a real Postgres instance. No mocking of the database layer.

CI runs automatically on every push and pull request via GitHub Actions.

## Deploying to Fly.io

The app is designed to run on Fly.io's free tier — it hibernates when idle and wakes on the first request.

**1. Install the Fly CLI and log in**

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

**2. Create the app and provision a Postgres database**

```bash
fly launch --name tt-<yourname> --region iad --no-deploy
fly postgres create --name tt-<yourname>-db
fly postgres attach tt-<yourname>-db
fly secrets set SECRET_KEY="$(openssl rand -hex 32)"
```

**3a. (Optional) Enable password reset emails**

The app uses [Resend](https://resend.com) for transactional email. Without these secrets the forgot-password flow silently skips sending — everything else works normally.

```bash
fly secrets set RESEND_API_KEY="re_..."
fly secrets set RESEND_FROM="noreply@yourdomain.com"
fly secrets set APP_URL="https://tt-<yourname>.fly.dev"
```

`RESEND_FROM` must be an address on a domain you have verified in the Resend dashboard.

**4. Deploy**

```bash
fly deploy
```

The app will be available at `https://tt-<yourname>.fly.dev`. Redeploy after code changes with `fly deploy`.

## Google SSO

The app supports sign-in with Google as an alternative to email/password. Both methods coexist — existing password accounts are unaffected. Accounts are matched by email: if the Google account email already exists in the database, that account is used; otherwise a new one is created with `password_hash = NULL`.

**How it works**

1. The frontend loads the [Google Identity Services (GIS)](https://developers.google.com/identity/gsi/web) SDK and fetches the client ID from `GET /auth/google/client-id`.
2. GIS renders a "Sign in with Google" button. When the user picks a Google account, GIS returns a signed ID token in the browser.
3. The frontend POSTs the token to `POST /auth/google`. The server verifies it server-side with `google-auth` and returns the same JWT the rest of the app uses.

**Setup**

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → Create credentials → OAuth 2.0 Client ID (Web application).
2. Add your origin(s) as **Authorised JavaScript origins** (e.g. `http://localhost:8000`, `https://yourapp.fly.dev`). No redirect URIs are needed.
3. Copy the client ID.

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | *(empty)* | OAuth 2.0 client ID from Google Cloud Console. If empty, the button is hidden and the endpoint returns 501. |

**Local setup**

```bash
fly secrets set GOOGLE_CLIENT_ID="<your-client-id>"   # production
# or add to .env for local dev:
echo 'GOOGLE_CLIENT_ID=<your-client-id>' >> .env
```

Leave `GOOGLE_CLIENT_ID` unset to disable Google sign-in entirely — no button appears and no JS errors occur.

## Password reset

The app has a built-in forgot-password flow using [Resend](https://resend.com) as the email provider.

**How it works**

1. User clicks "forgot password?" on the sign-in screen and submits their email.
2. If the email matches an account, a signed one-time token is stored in `password_reset_tokens` (expires in 60 minutes) and an email is sent with a link like `https://yourdomain.com/?token=<token>`.
3. Opening that link shows a "set new password" form. On submit the token is marked used and the password hash is updated.
4. The response is always `{"ok": true}` regardless of whether the email exists, to avoid leaking account information.

**Environment variables**

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEND_API_KEY` | *(empty)* | API key from [resend.com](https://resend.com). If empty, emails are skipped silently. |
| `RESEND_FROM` | `noreply@tikkit.fly.dev` | Sender address — must be on a domain verified in Resend. |
| `APP_URL` | `https://tikkit.fly.dev` | Base URL prepended to the reset link in emails. Set to `http://localhost:8000` for local testing. |

**Local testing without email**

Leave `RESEND_API_KEY` unset. After submitting the forgot-password form, grab the token directly from the database:

```sql
SELECT token FROM password_reset_tokens ORDER BY expires_at DESC LIMIT 1;
```

Then open `http://localhost:8000/?token=<token>` manually to reach the reset form.

## Usage

| Key | Action |
|-----|--------|
| Type | Search existing tasks or name a new one |
| `↵` | Start/stop the matched task — or create and start a new one if no match |
| `↑` `↓` | Navigate the task list |
| `Tab` | Expand/collapse today's session log for the selected task |
| `Esc` | Clear the search |

You can also click any task row to start/stop it, and hover to reveal the `✕` delete button.

Only one task runs at a time — starting a new one automatically stops the current one.

## Seed data

`seed.py` populates a user's tasks with two weeks of realistic sessions — useful for testing the history view without waiting for real usage to accumulate.

```bash
python3 seed.py --email you@example.com
```

It reads `DATABASE_URL` from `.env` by default. To target a different database:

```bash
python3 seed.py --email you@example.com --db postgresql://localhost/tt
```

It generates sessions across the last 10 weekdays for five built-in tasks (`deep work`, `email & slack`, `code review`, `meetings`, `planning`) and also adds historical sessions to any existing tasks already in the account (`React Query`, `Interview Prep`). Safe to re-run — it never removes existing tasks or sessions, only adds new ones.

## Data

All task data is stored per-user in a Postgres database. Locally this is the `tt` database on your Postgres.app instance. In production it's the Fly.io Postgres cluster attached to the app.

## Files

```
index.html            — the app UI
app.py                — FastAPI server (auth, data API, static files)
server.py             — simple local server (no auth, reads/writes data.json)
seed.py               — populates data.json with two weeks of sample sessions
requirements.txt      — Python dependencies
requirements-dev.txt  — dev/test dependencies (pytest, httpx)
.env.example          — environment variable template (copy to .env for local dev)
tests/                — test suite
Dockerfile            — container build for Fly.io
fly.toml              — Fly.io configuration
```
