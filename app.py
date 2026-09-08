import json
import os
import secrets
import time
import uuid as uuid_mod

import stripe

from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timedelta, timezone
from typing import Annotated

import bcrypt
import httpx
import psycopg2
import psycopg2.extras
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel

SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost/tt")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30
RESEND_API_KEY       = os.getenv("RESEND_API_KEY", "")
RESEND_FROM          = os.getenv("RESEND_FROM", "noreply@doingit.online")
APP_URL              = os.getenv("APP_URL", "https://doingit.online")
RESET_EXPIRE_MINUTES = 60
GOOGLE_CLIENT_ID       = os.getenv("GOOGLE_CLIENT_ID", "")
STRIPE_SECRET_KEY      = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET  = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID        = os.getenv("STRIPE_PRICE_ID", "")

if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY

bearer = HTTPBearer()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

CANONICAL_HOST = "doingit.online"

@app.middleware("http")
async def redirect_to_canonical(request: Request, call_next):
    host = request.headers.get("host", "").split(":")[0]
    if host and host != CANONICAL_HOST and host not in ("localhost", "127.0.0.1", "testserver"):
        url = str(request.url).replace(f"://{host}", f"://{CANONICAL_HOST}", 1)
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url, status_code=301)
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def init_db():
    for attempt in range(10):
        try:
            with psycopg2.connect(DATABASE_URL) as conn:
                with conn.cursor() as cur:
                    # ── Existing tables (unchanged) ──────────────────────────
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS users (
                            id            SERIAL PRIMARY KEY,
                            email         TEXT UNIQUE NOT NULL,
                            password_hash TEXT,
                            created_at    TIMESTAMPTZ DEFAULT NOW()
                        )
                    """)
                    cur.execute("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL")
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS user_data (
                            user_id    INTEGER PRIMARY KEY REFERENCES users(id),
                            tasks_json TEXT NOT NULL DEFAULT '{"tasks":[]}'
                        )
                    """)
                    # Plan B: mark which rows have been migrated to normalized tables.
                    # The blob is never deleted — revert by pointing GET/POST back at user_data.
                    cur.execute(
                        "ALTER TABLE user_data ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMPTZ"
                    )
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS password_reset_tokens (
                            token      TEXT PRIMARY KEY,
                            user_id    INTEGER NOT NULL REFERENCES users(id),
                            expires_at TIMESTAMPTZ NOT NULL,
                            used       BOOLEAN NOT NULL DEFAULT FALSE
                        )
                    """)
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free'")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_id TEXT")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_comped BOOLEAN DEFAULT FALSE")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT")
                    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE")

                    # ── New normalized tables ────────────────────────────────
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS tasks (
                            id      TEXT    NOT NULL,
                            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            name    TEXT    NOT NULL,
                            PRIMARY KEY (id, user_id)
                        )
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS sessions (
                            id       TEXT   NOT NULL PRIMARY KEY,
                            task_id  TEXT   NOT NULL,
                            user_id  INTEGER NOT NULL,
                            start_ts BIGINT NOT NULL,
                            end_ts   BIGINT,
                            FOREIGN KEY (task_id, user_id) REFERENCES tasks(id, user_id) ON DELETE CASCADE,
                            UNIQUE (task_id, user_id, start_ts)
                        )
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS later_items (
                            id       TEXT    NOT NULL,
                            user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            text     TEXT    NOT NULL,
                            position INTEGER NOT NULL DEFAULT 0,
                            PRIMARY KEY (id, user_id)
                        )
                    """)
                    cur.execute("CREATE INDEX IF NOT EXISTS sessions_user_start ON sessions(user_id, start_ts)")
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS done_items (
                            id       TEXT    NOT NULL,
                            user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            text     TEXT    NOT NULL,
                            done_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            PRIMARY KEY (id, user_id)
                        )
                    """)
                    cur.execute("CREATE INDEX IF NOT EXISTS done_items_user_done ON done_items(user_id, done_at DESC)")
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS tag_shares (
                            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            project_id TEXT    NOT NULL,
                            token      TEXT    NOT NULL UNIQUE,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            PRIMARY KEY (user_id, project_id)
                        )
                    """)
            return
        except psycopg2.OperationalError:
            if attempt == 9:
                raise
            time.sleep(2 ** attempt)


def migrate_blobs():
    """
    One-time migration: copy each user's JSON blob into normalized tables.
    Runs on every startup but is a no-op for already-migrated users.
    Safe to re-run: uses ON CONFLICT DO NOTHING / DO UPDATE.
    Plan B: user_data rows are never deleted; revert by swapping GET/POST back to blob logic.
    """
    try:
        with psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT user_id, tasks_json FROM user_data WHERE migrated_at IS NULL")
                rows = cur.fetchall()
    except Exception as e:
        print(f"[migration] could not read user_data: {e}")
        return

    for row in rows:
        uid = row["user_id"]
        try:
            payload = json.loads(row["tasks_json"] or '{"tasks":[]}')
            with psycopg2.connect(DATABASE_URL) as conn:
                with conn.cursor() as cur:
                    for task in payload.get("tasks", []):
                        cur.execute(
                            "INSERT INTO tasks (id, user_id, name) VALUES (%s, %s, %s) "
                            "ON CONFLICT (id, user_id) DO UPDATE SET name = EXCLUDED.name",
                            (task["id"], uid, task["name"]),
                        )
                        for s in task.get("sessions", []):
                            cur.execute(
                                "INSERT INTO sessions (id, task_id, user_id, start_ts, end_ts) "
                                "VALUES (%s, %s, %s, %s, %s) "
                                "ON CONFLICT (task_id, user_id, start_ts) DO NOTHING",
                                (str(uuid_mod.uuid4()), task["id"], uid, s["start"], s.get("end")),
                            )
                    for i, item in enumerate(payload.get("later", [])):
                        cur.execute(
                            "INSERT INTO later_items (id, user_id, text, position) "
                            "VALUES (%s, %s, %s, %s) "
                            "ON CONFLICT (id, user_id) DO NOTHING",
                            (item["id"], uid, item["text"], i),
                        )
                    cur.execute(
                        "UPDATE user_data SET migrated_at = NOW() WHERE user_id = %s",
                        (uid,),
                    )
                conn.commit()
            print(f"[migration] user {uid} migrated ok")
        except Exception as e:
            print(f"[migration] user {uid} FAILED: {e}")


@app.on_event("startup")
def startup():
    init_db()
    migrate_blobs()


def get_db():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    finally:
        conn.close()


def current_user_id(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
) -> int:
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
        return int(user_id)
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)


def make_token(user_id: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def user_id_from_share_token(token: str, db) -> int:
    db.execute("SELECT id FROM users WHERE share_token = %s", (token,))
    row = db.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Shared profile not found")
    return row["id"]


class AuthRequest(BaseModel):
    email: str
    password: str


class GoogleAuthRequest(BaseModel):
    credential: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


@app.get("/auth/google/client-id")
def google_client_id_endpoint():
    return {"client_id": GOOGLE_CLIENT_ID}


@app.post("/auth/google")
def google_auth(req: GoogleAuthRequest, db=Depends(get_db)):
    from google.oauth2 import id_token
    from google.auth.transport import requests as grequests
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google auth not configured")
    try:
        idinfo = id_token.verify_oauth2_token(req.credential, grequests.Request(), GOOGLE_CLIENT_ID)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid Google token")
    email = idinfo["email"]
    db.execute("SELECT id FROM users WHERE email = %s", (email,))
    row = db.fetchone()
    if row:
        user_id = row["id"]
    else:
        db.execute("INSERT INTO users (email, password_hash) VALUES (%s, NULL) RETURNING id", (email,))
        user_id = db.fetchone()["id"]
    return {"token": make_token(user_id)}


@app.post("/auth/signup")
def signup(req: AuthRequest, db: Annotated[psycopg2.extensions.cursor, Depends(get_db)]):
    db.execute("SELECT id FROM users WHERE email = %s", (req.email,))
    if db.fetchone():
        raise HTTPException(status_code=409, detail="Email already registered")
    hashed = hash_password(req.password)
    db.execute(
        "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
        (req.email, hashed),
    )
    user_id = db.fetchone()["id"]
    return {"token": make_token(user_id)}


@app.post("/auth/login")
def login(req: AuthRequest, db: Annotated[psycopg2.extensions.cursor, Depends(get_db)]):
    db.execute("SELECT id, password_hash FROM users WHERE email = %s", (req.email,))
    row = db.fetchone()
    if not row or not verify_password(req.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"token": make_token(row["id"])}


@app.post("/auth/forgot-password")
async def forgot_password(req: ForgotPasswordRequest, db=Depends(get_db)):
    db.execute("SELECT id FROM users WHERE email = %s", (req.email,))
    row = db.fetchone()
    if row:
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=RESET_EXPIRE_MINUTES)
        db.execute(
            "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (%s, %s, %s)",
            (token, row["id"], expires_at),
        )
        reset_url = f"{APP_URL}/?token={token}"
        async with httpx.AsyncClient() as client:
            await client.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}", "Content-Type": "application/json"},
                json={
                    "from": RESEND_FROM,
                    "to": [req.email],
                    "subject": "Reset your Doing It password",
                    "html": f"<p>Reset your Doing It password (expires in 1 hour):</p><p><a href='{reset_url}'>{reset_url}</a></p><p>If you didn't request this, ignore this email.</p>",
                },
            )
    return {"ok": True}


@app.post("/auth/reset-password")
def reset_password(req: ResetPasswordRequest, db=Depends(get_db)):
    db.execute(
        "SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = %s",
        (req.token,),
    )
    row = db.fetchone()
    if not row or row["used"] or row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invalid or expired token")
    if len(req.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
    db.execute("UPDATE users SET password_hash = %s WHERE id = %s", (hash_password(req.password), row["user_id"]))
    db.execute("UPDATE password_reset_tokens SET used = TRUE WHERE token = %s", (req.token,))
    return {"ok": True}


def merge_projects_from_blob(tasks: list, blob_json: str | None) -> tuple[list, list]:
    """Attach `projects` and per-task `projectId` from `user_data.tasks_json`.

    Tasks/sessions are authoritative in relational tables; the JSON blob carries
    project metadata written by POST /data (same payload the client sends).
    """
    if not blob_json:
        return tasks, []
    try:
        blob = json.loads(blob_json)
    except (json.JSONDecodeError, TypeError):
        return tasks, []
    raw_projects = blob.get("projects")
    projects: list = raw_projects if isinstance(raw_projects, list) else []
    valid_ids = {
        p["id"]
        for p in projects
        if isinstance(p, dict) and p.get("id")
    }
    blob_tasks = blob.get("tasks")
    if not isinstance(blob_tasks, list):
        blob_tasks = []
    id_to_project: dict[str, str | None] = {}
    for t in blob_tasks:
        if not isinstance(t, dict) or not t.get("id"):
            continue
        pid = t.get("projectId")
        if pid is None:
            id_to_project[t["id"]] = None
        elif pid in valid_ids:
            id_to_project[t["id"]] = pid
    for task in tasks:
        tid = task.get("id")
        if tid not in id_to_project:
            continue
        val = id_to_project[tid]
        if val is None:
            task["projectId"] = None
        else:
            task["projectId"] = val
    return tasks, projects


def _fetch_data(user_id: int, db):
    db.execute("""
        SELECT
            t.id,
            t.name,
            COALESCE(
                json_agg(
                    json_build_object('start', s.start_ts, 'end', s.end_ts)
                    ORDER BY s.start_ts ASC
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'::json
            ) AS sessions
        FROM tasks t
        LEFT JOIN sessions s ON s.task_id = t.id AND s.user_id = t.user_id
        WHERE t.user_id = %s
        GROUP BY t.id, t.name
        ORDER BY MAX(s.start_ts) DESC NULLS LAST
    """, (user_id,))
    tasks = [
        {"id": r["id"], "name": r["name"], "sessions": r["sessions"] or []}
        for r in db.fetchall()
    ]

    db.execute(
        "SELECT id, text FROM later_items WHERE user_id = %s ORDER BY position",
        (user_id,),
    )
    later = [{"id": r["id"], "text": r["text"]} for r in db.fetchall()]

    db.execute("SELECT theme FROM users WHERE id = %s", (user_id,))
    theme_row = db.fetchone()
    theme = theme_row["theme"] if theme_row else None

    db.execute("SELECT tasks_json FROM user_data WHERE user_id = %s", (user_id,))
    blob_row = db.fetchone()
    blob_json = blob_row["tasks_json"] if blob_row else None
    tasks, projects = merge_projects_from_blob(tasks, blob_json)

    return {"tasks": tasks, "later": later, "theme": theme, "projects": projects}


@app.get("/data")
def get_data(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    return JSONResponse(_fetch_data(user_id, db))


@app.post("/data", status_code=204)
async def post_data(
    request: Request,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    body = await request.body()
    payload = json.loads(body)
    tasks = payload.get("tasks", [])
    later = payload.get("later", [])

    # ── Sync tasks ───────────────────────────────────────────────────────────
    incoming_task_ids = [t["id"] for t in tasks]
    if incoming_task_ids:
        # Delete tasks (and their sessions via CASCADE) no longer in the payload
        db.execute(
            "DELETE FROM tasks WHERE user_id = %s AND id != ALL(%s)",
            (user_id, incoming_task_ids),
        )
    else:
        db.execute("DELETE FROM tasks WHERE user_id = %s", (user_id,))

    for task in tasks:
        db.execute(
            "INSERT INTO tasks (id, user_id, name) VALUES (%s, %s, %s) "
            "ON CONFLICT (id, user_id) DO UPDATE SET name = EXCLUDED.name",
            (task["id"], user_id, task["name"]),
        )

        # ── Sync sessions for this task ──────────────────────────────────────
        incoming_starts = [s["start"] for s in task.get("sessions", [])]
        if incoming_starts:
            db.execute(
                "DELETE FROM sessions WHERE task_id = %s AND user_id = %s AND start_ts != ALL(%s)",
                (task["id"], user_id, incoming_starts),
            )
        else:
            db.execute(
                "DELETE FROM sessions WHERE task_id = %s AND user_id = %s",
                (task["id"], user_id),
            )

        for s in task.get("sessions", []):
            db.execute(
                "INSERT INTO sessions (id, task_id, user_id, start_ts, end_ts) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (task_id, user_id, start_ts) DO UPDATE SET end_ts = EXCLUDED.end_ts",
                (str(uuid_mod.uuid4()), task["id"], user_id, s["start"], s.get("end")),
            )

    # ── Drop share links for tags the payload no longer defines ──────────────
    # Only when `projects` is present: an older client that omits the key must
    # not wipe the user's timesheet links.
    projects = payload.get("projects")
    if isinstance(projects, list):
        project_ids = [p["id"] for p in projects if isinstance(p, dict) and p.get("id")]
        if project_ids:
            db.execute(
                "DELETE FROM tag_shares WHERE user_id = %s AND project_id != ALL(%s)",
                (user_id, project_ids),
            )
        else:
            db.execute("DELETE FROM tag_shares WHERE user_id = %s", (user_id,))

    # ── Sync later items ─────────────────────────────────────────────────────
    db.execute("DELETE FROM later_items WHERE user_id = %s", (user_id,))
    for i, item in enumerate(later):
        db.execute(
            "INSERT INTO later_items (id, user_id, text, position) VALUES (%s, %s, %s, %s)",
            (item["id"], user_id, item["text"], i),
        )

    # Keep blob in sync for Plan B rollback
    db.execute(
        "INSERT INTO user_data (user_id, tasks_json, migrated_at) VALUES (%s, %s, NOW()) "
        "ON CONFLICT (user_id) DO UPDATE SET tasks_json = EXCLUDED.tasks_json",
        (user_id, body.decode()),
    )

    return Response(status_code=204)


class PreferencesRequest(BaseModel):
    theme: str | None = None


VALID_THEMES = {"light", "dark"}


@app.get("/preferences")
def get_preferences(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("SELECT theme FROM users WHERE id = %s", (user_id,))
    row = db.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    return {"theme": row["theme"]}


@app.put("/preferences", status_code=204)
def put_preferences(
    req: PreferencesRequest,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    if req.theme is not None and req.theme not in VALID_THEMES:
        raise HTTPException(status_code=422, detail="theme must be 'light', 'dark', or null")
    db.execute("UPDATE users SET theme = %s WHERE id = %s", (req.theme, user_id))
    return Response(status_code=204)


class MarkDoneRequest(BaseModel):
    id: str
    text: str


@app.post("/done", status_code=201)
def mark_done(
    req: MarkDoneRequest,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute(
        "INSERT INTO done_items (id, user_id, text) VALUES (%s, %s, %s) "
        "ON CONFLICT (id, user_id) DO NOTHING",
        (req.id, user_id, req.text),
    )
    return {"ok": True}


def _fetch_done(user_id: int, db, offset: int = 0, limit: int = 50):
    limit = min(limit, 100)
    db.execute(
        "SELECT id, text, done_at FROM done_items "
        "WHERE user_id = %s ORDER BY done_at DESC LIMIT %s OFFSET %s",
        (user_id, limit, offset),
    )
    items = [
        {"id": r["id"], "text": r["text"], "done_at": r["done_at"].isoformat()}
        for r in db.fetchall()
    ]
    db.execute("SELECT COUNT(*) AS cnt FROM done_items WHERE user_id = %s", (user_id,))
    total = db.fetchone()["cnt"]
    return {"items": items, "total": total}


@app.get("/done")
def get_done(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
    offset: int = 0,
    limit: int = 50,
):
    return _fetch_done(user_id, db, offset, limit)


def _fetch_done_stats(user_id: int, db):
    # Done this week (Monday-based)
    db.execute("""
        SELECT COUNT(*) AS cnt FROM done_items
        WHERE user_id = %s AND done_at >= date_trunc('week', NOW())
    """, (user_id,))
    this_week = db.fetchone()["cnt"]

    # Done this month
    db.execute("""
        SELECT COUNT(*) AS cnt FROM done_items
        WHERE user_id = %s AND done_at >= date_trunc('month', NOW())
    """, (user_id,))
    this_month = db.fetchone()["cnt"]

    # Weeks since signup (capped at 10)
    db.execute("""
        SELECT GREATEST(1, LEAST(10,
            CEIL(EXTRACT(EPOCH FROM NOW() - created_at) / (7*86400))
        ))::int AS weeks
        FROM users WHERE id = %s
    """, (user_id,))
    max_weeks = db.fetchone()["weeks"]

    # Weekly counts for sparkline (most recent max_weeks, oldest first)
    db.execute("""
        SELECT date_trunc('week', done_at) AS wk, COUNT(*) AS cnt
        FROM done_items
        WHERE user_id = %s AND done_at >= NOW() - make_interval(weeks => %s)
        GROUP BY wk ORDER BY wk
    """, (user_id, max_weeks))
    rows = {r["wk"]: r["cnt"] for r in db.fetchall()}

    # Build array of counts per week (oldest first)
    from datetime import timedelta
    now_trunc = db.execute("SELECT date_trunc('week', NOW()) AS wk")
    current_wk = db.fetchone()["wk"]
    weekly = []
    for i in range(max_weeks - 1, -1, -1):
        wk = current_wk - timedelta(weeks=i)
        weekly.append(rows.get(wk, 0))

    # Average per week over last 4 weeks (or fewer if signed up recently)
    avg_weeks = min(4, max_weeks)
    avg_total = sum(weekly[-avg_weeks:])
    avg_per_week = round(avg_total / avg_weeks, 1)

    return {
        "this_month": this_month,
        "this_week": this_week,
        "avg_per_week": avg_per_week,
        "avg_weeks": avg_weeks,
        "weekly": weekly,
    }


@app.get("/done/stats")
def done_stats(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    return _fetch_done_stats(user_id, db)


def _merged_intervals_ms(intervals):
    """Total length of the union of (start, end) intervals — overlap counted once."""
    total = 0
    cur_start = cur_end = None
    for start, end in sorted(intervals):
        if cur_end is None or start > cur_end:
            if cur_end is not None:
                total += cur_end - cur_start
            cur_start, cur_end = start, end
        elif end > cur_end:
            cur_end = end
    if cur_end is not None:
        total += cur_end - cur_start
    return total


def _fetch_monthly_report(user_id: int, db):
    thirty_days_ago_ms = int((time.time() - 30 * 86400) * 1000)
    db.execute("""
        SELECT t.name,
               SUM(s.end_ts - s.start_ts) AS total_ms,
               COUNT(*) AS session_count
        FROM sessions s
        JOIN tasks t ON t.id = s.task_id AND t.user_id = s.user_id
        WHERE s.user_id = %s
          AND s.start_ts >= %s
          AND s.end_ts IS NOT NULL
        GROUP BY t.name
        ORDER BY total_ms DESC
    """, (user_id, thirty_days_ago_ms))
    tasks = [
        {"name": r["name"], "total_ms": int(r["total_ms"]), "session_count": r["session_count"]}
        for r in db.fetchall()
    ]
    total_ms = sum(t["total_ms"] for t in tasks)
    db.execute("""
        SELECT start_ts, end_ts FROM sessions
        WHERE user_id = %s AND start_ts >= %s AND end_ts IS NOT NULL
    """, (user_id, thirty_days_ago_ms))
    no_overlap_ms = _merged_intervals_ms(
        (int(r["start_ts"]), int(r["end_ts"])) for r in db.fetchall()
    )
    period_start = datetime.fromtimestamp(thirty_days_ago_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    period_end = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return {
        "tasks": tasks,
        "total_ms": total_ms,
        "no_overlap_ms": no_overlap_ms,
        "period_start": period_start,
        "period_end": period_end,
    }


@app.get("/report/monthly")
def monthly_report(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    return _fetch_monthly_report(user_id, db)


# ── Share endpoints ──────────────────────────────────────────────────────────

@app.get("/share/status")
def share_status(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("SELECT share_token FROM users WHERE id = %s", (user_id,))
    row = db.fetchone()
    token = row["share_token"] if row else None
    return {"enabled": bool(token), "share_token": token}


@app.post("/share/enable")
def share_enable(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("SELECT share_token FROM users WHERE id = %s", (user_id,))
    row = db.fetchone()
    if row and row["share_token"]:
        return {"share_token": row["share_token"]}
    token = str(uuid_mod.uuid4())
    db.execute("UPDATE users SET share_token = %s WHERE id = %s", (token, user_id))
    return {"share_token": token}


@app.post("/share/disable")
def share_disable(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("UPDATE users SET share_token = NULL WHERE id = %s", (user_id,))
    return {"ok": True}


@app.get("/shared/{token}/data")
def shared_get_data(token: str, db: Annotated[psycopg2.extensions.cursor, Depends(get_db)]):
    uid = user_id_from_share_token(token, db)
    return JSONResponse(_fetch_data(uid, db))


@app.get("/shared/{token}/done")
def shared_get_done(
    token: str,
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
    offset: int = 0,
    limit: int = 50,
):
    uid = user_id_from_share_token(token, db)
    return _fetch_done(uid, db, offset, limit)


@app.get("/shared/{token}/done/stats")
def shared_done_stats(token: str, db: Annotated[psycopg2.extensions.cursor, Depends(get_db)]):
    uid = user_id_from_share_token(token, db)
    return _fetch_done_stats(uid, db)


@app.get("/shared/{token}/report/monthly")
def shared_monthly_report(token: str, db: Annotated[psycopg2.extensions.cursor, Depends(get_db)]):
    uid = user_id_from_share_token(token, db)
    return _fetch_monthly_report(uid, db)


# ── Tag timesheets ───────────────────────────────────────────────────────────

def _local_naive(ts_ms: int, tz_offset_min: int) -> datetime:
    """The wall-clock time a viewer at `tz_offset_min` sees for a UTC timestamp."""
    utc = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).replace(tzinfo=None)
    return utc - timedelta(minutes=tz_offset_min)


def _to_utc_ms(local: datetime, tz_offset_min: int) -> int:
    return int(
        (local + timedelta(minutes=tz_offset_min)).replace(tzinfo=timezone.utc).timestamp() * 1000
    )


def _local_date_str(ts_ms: int, tz_offset_min: int) -> str:
    return _local_naive(ts_ms, tz_offset_min).strftime("%Y-%m-%d")


def _next_local_midnight_ms(ts_ms: int, tz_offset_min: int) -> int:
    local = _local_naive(ts_ms, tz_offset_min)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return _to_utc_ms(midnight, tz_offset_min)


def _period_bounds_ms(tz_offset_min: int, now_ms: int) -> dict[str, tuple[int, int]]:
    """Start/end of the current week, month and year, in UTC milliseconds.

    `tz_offset_min` follows JavaScript's `Date.getTimezoneOffset()`: minutes to
    add to local time to get UTC, so UTC-3 is 180. Weeks start on Monday, as
    everywhere else in the app.
    """
    local = _local_naive(now_ms, tz_offset_min)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return {
        "week": (_to_utc_ms(midnight - timedelta(days=midnight.weekday()), tz_offset_min), now_ms),
        "month": (_to_utc_ms(midnight.replace(day=1), tz_offset_min), now_ms),
        "year": (_to_utc_ms(midnight.replace(month=1, day=1), tz_offset_min), now_ms),
    }


def _summarize_tag_timesheet(sessions, tz_offset_min: int, now_ms: int) -> dict:
    """Roll a tag's sessions up into week / month / year figures plus a daily series.

    `sessions` is an iterable of `(start_ms, end_ms_or_None, task_name)`. Open
    sessions count up to `now_ms`. Sessions are clipped to each period, so one
    that runs across midnight on a Sunday counts in both weeks, split.
    """
    sessions = list(sessions)
    bounds = _period_bounds_ms(tz_offset_min, now_ms)
    result: dict = {}

    for period, (start, end) in bounds.items():
        clipped = []
        for s_start, s_end, name in sessions:
            a = max(s_start, start)
            b = min(s_end if s_end is not None else now_ms, end)
            if b > a:
                clipped.append((a, b, name))
        per_task: dict[str, dict] = {}
        for a, b, name in clipped:
            entry = per_task.setdefault(name, {"name": name, "total_ms": 0, "session_count": 0})
            entry["total_ms"] += b - a
            entry["session_count"] += 1
        result[period] = {
            "start": _local_date_str(start, tz_offset_min),
            "end": _local_date_str(end, tz_offset_min),
            "total_ms": sum(b - a for a, b, _ in clipped),
            "net_ms": _merged_intervals_ms((a, b) for a, b, _ in clipped),
            "tasks": sorted(per_task.values(), key=lambda t: -t["total_ms"]),
        }

    # Daily series over the year window, split at the viewer's local midnights
    year_start, year_end = bounds["year"]
    by_day: dict[str, list[tuple[int, int]]] = {}
    for s_start, s_end, _ in sessions:
        a = max(s_start, year_start)
        b = min(s_end if s_end is not None else now_ms, year_end)
        while b > a:
            piece_end = min(b, _next_local_midnight_ms(a, tz_offset_min))
            by_day.setdefault(_local_date_str(a, tz_offset_min), []).append((a, piece_end))
            a = piece_end
    result["days"] = [
        {
            "date": day,
            "total_ms": sum(b - a for a, b in intervals),
            "net_ms": _merged_intervals_ms(intervals),
        }
        for day, intervals in sorted(by_day.items())
    ]
    return result


def _tag_from_blob(user_id: int, project_id: str, db) -> tuple[str | None, list[str]]:
    """The tag's name and the ids of the tasks carrying it.

    Tag membership lives in `user_data.tasks_json` (see `merge_projects_from_blob`);
    sessions live in the relational tables.
    """
    db.execute("SELECT tasks_json FROM user_data WHERE user_id = %s", (user_id,))
    row = db.fetchone()
    try:
        blob = json.loads(row["tasks_json"]) if row and row["tasks_json"] else {}
    except (json.JSONDecodeError, TypeError):
        return None, []
    projects = blob.get("projects")
    if not isinstance(projects, list):
        projects = []
    tag = next(
        (p for p in projects if isinstance(p, dict) and p.get("id") == project_id),
        None,
    )
    if tag is None:
        return None, []
    blob_tasks = blob.get("tasks")
    if not isinstance(blob_tasks, list):
        blob_tasks = []
    task_ids = [
        t["id"]
        for t in blob_tasks
        if isinstance(t, dict) and t.get("id") and t.get("projectId") == project_id
    ]
    return tag.get("name"), task_ids


def _fetch_tag_timesheet(user_id: int, project_id: str, db, tz_offset_min: int = 0):
    tag_name, task_ids = _tag_from_blob(user_id, project_id, db)
    if tag_name is None:
        raise HTTPException(status_code=404, detail="Timesheet not found")

    now_ms = int(time.time() * 1000)
    year_start = _period_bounds_ms(tz_offset_min, now_ms)["year"][0]
    rows = []
    if task_ids:
        db.execute("""
            SELECT s.start_ts, s.end_ts, t.name
            FROM sessions s
            JOIN tasks t ON t.id = s.task_id AND t.user_id = s.user_id
            WHERE s.user_id = %s
              AND s.task_id = ANY(%s)
              AND COALESCE(s.end_ts, %s) >= %s
            ORDER BY s.start_ts
        """, (user_id, task_ids, now_ms, year_start))
        rows = [
            (int(r["start_ts"]), None if r["end_ts"] is None else int(r["end_ts"]), r["name"])
            for r in db.fetchall()
        ]

    return {
        "tag": tag_name,
        "now": now_ms,
        "running_count": sum(1 for _, end, _ in rows if end is None),
        **_summarize_tag_timesheet(rows, tz_offset_min, now_ms),
    }


def tag_share_from_token(token: str, db) -> tuple[int, str]:
    db.execute("SELECT user_id, project_id FROM tag_shares WHERE token = %s", (token,))
    row = db.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Timesheet not found")
    return row["user_id"], row["project_id"]


@app.get("/share/tags")
def share_tags(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute(
        "SELECT project_id, token FROM tag_shares WHERE user_id = %s ORDER BY created_at",
        (user_id,),
    )
    rows = db.fetchall()
    shares = []
    for r in rows:
        tag_name, _ = _tag_from_blob(user_id, r["project_id"], db)
        shares.append({"project_id": r["project_id"], "tag": tag_name, "token": r["token"]})
    return {"shares": shares}


@app.post("/share/tags/{project_id}/enable")
def share_tag_enable(
    project_id: str,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    tag_name, _ = _tag_from_blob(user_id, project_id, db)
    if tag_name is None:
        raise HTTPException(status_code=404, detail="Tag not found")
    db.execute(
        "SELECT token FROM tag_shares WHERE user_id = %s AND project_id = %s",
        (user_id, project_id),
    )
    row = db.fetchone()
    if row:
        return {"project_id": project_id, "tag": tag_name, "token": row["token"]}
    token = str(uuid_mod.uuid4())
    db.execute(
        "INSERT INTO tag_shares (user_id, project_id, token) VALUES (%s, %s, %s)",
        (user_id, project_id, token),
    )
    return {"project_id": project_id, "tag": tag_name, "token": token}


@app.post("/share/tags/{project_id}/disable")
def share_tag_disable(
    project_id: str,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute(
        "DELETE FROM tag_shares WHERE user_id = %s AND project_id = %s",
        (user_id, project_id),
    )
    return {"ok": True}


@app.get("/timesheet/{token}/data")
def timesheet_data(
    token: str,
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
    tz: int = 0,
):
    user_id, project_id = tag_share_from_token(token, db)
    return _fetch_tag_timesheet(user_id, project_id, db, tz)


def count_today_sessions(user_id: int, db) -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    db.execute("""
        SELECT COUNT(*) AS cnt FROM sessions
        WHERE user_id = %s
          AND to_char(to_timestamp(start_ts / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') = %s
    """, (user_id, today))
    row = db.fetchone()
    return int(row["cnt"]) if row else 0


@app.post("/sessions/start")
def session_start(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute(
        "SELECT subscription_status, is_comped FROM users WHERE id = %s",
        (user_id,),
    )
    row = db.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    if row["is_comped"] or row["subscription_status"] == "active":
        return {"ok": True}
    if count_today_sessions(user_id, db) >= 5:
        raise HTTPException(
            status_code=402,
            detail="You've reached your 5 free sessions for today. Upgrade for unlimited.",
        )
    return {"ok": True}


class CheckoutRequest(BaseModel):
    guest_trial_start: int | None = None


@app.post("/billing/checkout")
def billing_checkout(
    req: CheckoutRequest,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("SELECT email, stripe_customer_id FROM users WHERE id = %s", (user_id,))
    row = db.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    customer_id = row["stripe_customer_id"]
    if not customer_id:
        customer = stripe.Customer.create(email=row["email"], metadata={"user_id": str(user_id)})
        customer_id = customer.id
        db.execute("UPDATE users SET stripe_customer_id = %s WHERE id = %s", (customer_id, user_id))
    trial_end = None
    if req.guest_trial_start:
        guest_dt = datetime.fromtimestamp(req.guest_trial_start / 1000, tz=timezone.utc)
        trial_end_dt = guest_dt + timedelta(days=30)
        if trial_end_dt > datetime.now(timezone.utc):
            trial_end = int(trial_end_dt.timestamp())
            db.execute("UPDATE users SET trial_started_at = %s WHERE id = %s", (guest_dt, user_id))
    checkout_kwargs: dict = dict(
        customer=customer_id,
        mode="subscription",
        line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
        success_url=f"{APP_URL}/billing/success",
        cancel_url=f"{APP_URL}/",
    )
    if trial_end:
        checkout_kwargs["subscription_data"] = {"trial_end": trial_end}
    else:
        checkout_kwargs["subscription_data"] = {"trial_period_days": 30}
    session = stripe.checkout.Session.create(**checkout_kwargs)
    return {"url": session.url}


@app.get("/billing/portal")
def billing_portal(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("SELECT stripe_customer_id FROM users WHERE id = %s", (user_id,))
    row = db.fetchone()
    if not row or not row["stripe_customer_id"]:
        raise HTTPException(status_code=400, detail="No billing account found")
    portal = stripe.billing_portal.Session.create(
        customer=row["stripe_customer_id"],
        return_url=f"{APP_URL}/",
    )
    return {"url": portal.url}


@app.get("/billing/status")
def billing_status(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    db.execute("SELECT subscription_status, is_comped FROM users WHERE id = %s", (user_id,))
    row = db.fetchone()
    if not row:
        raise HTTPException(status_code=404)
    return {
        "subscription_status": row["subscription_status"] or "free",
        "is_comped": row["is_comped"] or False,
    }


@app.post("/billing/webhook")
async def billing_webhook(request: Request, db=Depends(get_db)):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")
    et = event["type"]
    if et == "checkout.session.completed":
        obj = event["data"]["object"]
        db.execute(
            "UPDATE users SET subscription_status = 'active', subscription_id = %s "
            "WHERE stripe_customer_id = %s",
            (obj.get("subscription"), obj["customer"]),
        )
    elif et == "invoice.payment_succeeded":
        obj = event["data"]["object"]
        period_end = datetime.fromtimestamp(obj.get("period_end", 0), tz=timezone.utc)
        db.execute(
            "UPDATE users SET subscription_status = 'active', subscription_current_period_end = %s "
            "WHERE subscription_id = %s",
            (period_end, obj.get("subscription")),
        )
    elif et == "invoice.payment_failed":
        obj = event["data"]["object"]
        db.execute(
            "UPDATE users SET subscription_status = 'past_due' WHERE subscription_id = %s",
            (obj.get("subscription"),),
        )
    elif et == "customer.subscription.deleted":
        obj = event["data"]["object"]
        db.execute(
            "UPDATE users SET subscription_status = 'canceled', subscription_id = NULL "
            "WHERE subscription_id = %s",
            (obj["id"],),
        )
    elif et == "customer.subscription.updated":
        obj = event["data"]["object"]
        new_status = "active" if obj["status"] in ("active", "trialing") else obj["status"]
        period_end = datetime.fromtimestamp(obj["current_period_end"], tz=timezone.utc)
        db.execute(
            "UPDATE users SET subscription_status = %s, subscription_current_period_end = %s "
            "WHERE subscription_id = %s",
            (new_status, period_end, obj["id"]),
        )
    return {"ok": True}


@app.get("/billing/success")
def billing_success():
    return FileResponse("index.html")


@app.get("/favicon-local.png")
def favicon_local():
    return FileResponse("favicon-local.png", media_type="image/png")


@app.get("/shared/{token}")
def shared_root(token: str):
    return FileResponse("index.html")


@app.get("/shared/{token}/done-list")
def shared_done_page(token: str):
    return FileResponse("index.html")


@app.get("/shared/{token}/report")
def shared_report_page(token: str):
    return FileResponse("index.html")


@app.get("/timesheet/{token}")
def timesheet_page(token: str):
    return FileResponse("index.html")


@app.get("/done-list")
def done_page():
    return FileResponse("index.html")


@app.get("/report")
def report_page():
    return FileResponse("index.html")


@app.get("/")
def root():
    return FileResponse("index.html")
