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


@app.get("/data")
def get_data(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
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

    return JSONResponse({"tasks": tasks, "later": later})


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


@app.get("/")
def root():
    return FileResponse("index.html")
