# AI Time Tracker

A minimal, keyboard-driven time tracker inspired by Notational Velocity.

![tt screenshot](screenshot.png)

## Running locally

Install dependencies and start the server:

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

Navigate to [http://localhost:8000](http://localhost:8000). You'll be prompted to sign up on first run. Data is stored in `tt.db` in the project folder.

## Deploying to Fly.io

The app is designed to run on Fly.io's free tier — it hibernates when idle (zero machines running) and wakes on the first request.

**1. Install the Fly CLI and log in**

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

**2. Create the app and provision a volume**

```bash
fly launch --name tt-<yourname> --region iad --no-deploy
fly secrets set SECRET_KEY="$(openssl rand -hex 32)"
fly volumes create tt_data --region iad --size 1
```

**3. Deploy**

```bash
fly deploy
```

The app will be available at `https://tt-<yourname>.fly.dev`. After any code change, redeploy with `fly deploy`.

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

All data is stored in `data.json` in the project folder. It's plain JSON and safe to edit by hand, back up, or put in version control.

## Files

```
index.html        — the app UI
app.py            — FastAPI server (auth, data API, static files)
requirements.txt  — Python dependencies
Dockerfile        — container build for Fly.io
fly.toml          — Fly.io configuration
server.py         — original single-user local server (kept for reference)
data.json         — original local data file (kept for reference)
```
