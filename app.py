import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
DB_PATH = os.getenv("DB_PATH", "tt.db")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer()

app = FastAPI()


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                email         TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS user_data (
                user_id    INTEGER PRIMARY KEY REFERENCES users(id),
                tasks_json TEXT NOT NULL DEFAULT '{"tasks":[]}'
            );
        """)


@app.on_event("startup")
def startup():
    init_db()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
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
def signup(req: AuthRequest, db: Annotated[sqlite3.Connection, Depends(get_db)]):
    existing = db.execute("SELECT id FROM users WHERE email = ?", (req.email,)).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    hashed = pwd_context.hash(req.password)
    cursor = db.execute(
        "INSERT INTO users (email, password_hash) VALUES (?, ?)", (req.email, hashed)
    )
    return {"token": make_token(cursor.lastrowid)}


@app.post("/auth/login")
def login(req: AuthRequest, db: Annotated[sqlite3.Connection, Depends(get_db)]):
    row = db.execute(
        "SELECT id, password_hash FROM users WHERE email = ?", (req.email,)
    ).fetchone()
    if not row or not pwd_context.verify(req.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"token": make_token(row["id"])}


@app.get("/data")
def get_data(
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
):
    row = db.execute(
        "SELECT tasks_json FROM user_data WHERE user_id = ?", (user_id,)
    ).fetchone()
    tasks_json = row["tasks_json"] if row else '{"tasks":[]}'
    return JSONResponse(content=json.loads(tasks_json))


@app.post("/data", status_code=204)
async def post_data(
    request: Request,
    user_id: Annotated[int, Depends(current_user_id)],
    db: Annotated[sqlite3.Connection, Depends(get_db)],
):
    body = await request.body()
    db.execute(
        "INSERT INTO user_data (user_id, tasks_json) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET tasks_json = excluded.tasks_json",
        (user_id, body.decode()),
    )
    return Response(status_code=204)


@app.get("/favicon.svg")
def favicon():
    return FileResponse("favicon.svg", media_type="image/svg+xml")


@app.get("/")
def root():
    return FileResponse("index.html")
