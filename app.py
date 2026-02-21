import json
import os
import time

from dotenv import load_dotenv
load_dotenv()
from datetime import datetime, timedelta, timezone
from typing import Annotated

import bcrypt
import psycopg2
import psycopg2.extras
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel

SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost/tt")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30

bearer = HTTPBearer()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


app = FastAPI()


def init_db():
    for attempt in range(10):
        try:
            with psycopg2.connect(DATABASE_URL) as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS users (
                            id            SERIAL PRIMARY KEY,
                            email         TEXT UNIQUE NOT NULL,
                            password_hash TEXT NOT NULL,
                            created_at    TIMESTAMPTZ DEFAULT NOW()
                        )
                    """)
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS user_data (
                            user_id    INTEGER PRIMARY KEY REFERENCES users(id),
                            tasks_json TEXT NOT NULL DEFAULT '{"tasks":[]}'
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
