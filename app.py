import json
import os
import secrets
import time

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
RESEND_FROM          = os.getenv("RESEND_FROM", "noreply@tikkit.fly.dev")
APP_URL              = os.getenv("APP_URL", "https://tikkit.fly.dev")
RESET_EXPIRE_MINUTES = 60
GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")

bearer = HTTPBearer()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")


def init_db():
    for attempt in range(10):
        try:
            with psycopg2.connect(DATABASE_URL) as conn:
                with conn.cursor() as cur:
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
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS password_reset_tokens (
                            token      TEXT PRIMARY KEY,
                            user_id    INTEGER NOT NULL REFERENCES users(id),
                            expires_at TIMESTAMPTZ NOT NULL,
                            used       BOOLEAN NOT NULL DEFAULT FALSE
                        )
                    """)
            return
        except psycopg2.OperationalError:
            if attempt == 9:
                raise
            time.sleep(2 ** attempt)


@app.on_event("startup")
def startup():
    init_db()


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
                    "subject": "Reset your Tikkit password",
                    "html": f"<p>Reset your Tikkit password (expires in 1 hour):</p><p><a href='{reset_url}'>{reset_url}</a></p><p>If you didn't request this, ignore this email.</p>",
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
    db.execute("SELECT tasks_json FROM user_data WHERE user_id = %s", (user_id,))
    row = db.fetchone()
    tasks_json = row["tasks_json"] if row else '{"tasks":[]}'
    return JSONResponse(content=json.loads(tasks_json))


@app.post("/data", status_code=204)
async def post_data(
    request: Request,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[psycopg2.extensions.cursor, Depends(get_db)],
):
    body = await request.body()
    db.execute(
        "INSERT INTO user_data (user_id, tasks_json) VALUES (%s, %s) "
        "ON CONFLICT (user_id) DO UPDATE SET tasks_json = EXCLUDED.tasks_json",
        (user_id, body.decode()),
    )
    return Response(status_code=204)


@app.get("/favicon.svg")
def favicon():
    return FileResponse("favicon.svg", media_type="image/svg+xml")


@app.get("/favicon-local.svg")
def favicon_local():
    return FileResponse("favicon-local.svg", media_type="image/svg+xml")


@app.get("/favicon-local.svg")
def favicon_local():
    return FileResponse("favicon-local.svg", media_type="image/svg+xml")


@app.get("/")
def root():
    return FileResponse("index.html")
