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

**3. Deploy**

```bash
fly deploy
```

The app will be available at `https://tt-<yourname>.fly.dev`. Redeploy after code changes with `fly deploy`.

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

## Data

All task data is stored per-user in a Postgres database. Locally this is the `tt` database on your Postgres.app instance. In production it's the Fly.io Postgres cluster attached to the app.

## Files

```
index.html            — the app UI
app.py                — FastAPI server (auth, data API, static files)
requirements.txt      — Python dependencies
requirements-dev.txt  — dev/test dependencies (pytest, httpx)
.env.example          — environment variable template (copy to .env for local dev)
tests/                — test suite
Dockerfile            — container build for Fly.io
fly.toml              — Fly.io configuration
```
