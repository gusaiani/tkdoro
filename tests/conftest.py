import os

# Must be set before importing app — load_dotenv() does not override existing env vars,
# so setting these here takes precedence over whatever is in .env.
os.environ.setdefault("DATABASE_URL", "postgresql://localhost/tt_test")
os.environ.setdefault("SECRET_KEY", "test-secret-for-testing")

import psycopg2
import psycopg2.extras
import pytest
from fastapi.testclient import TestClient

from app import app, get_db

_DB_URL = os.environ["DATABASE_URL"]


@pytest.fixture(scope="session", autouse=True)
def init_test_db():
    """
    Ensure the test database schema exists. Runs once per session.

    Uses CREATE TABLE IF NOT EXISTS (no DROP) so it is safe even if DATABASE_URL
    happens to point at a dev database — existing data is never destroyed.
    """
    conn = psycopg2.connect(_DB_URL)
    conn.autocommit = True
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
    conn.close()


@pytest.fixture
def db_conn(init_test_db):
    """
    Opens a DB connection and wraps each test in a transaction.

    All writes made during the test are rolled back on teardown, keeping
    tests isolated without truncating tables between runs. Reads within the
    same connection see uncommitted writes, so multi-step test scenarios
    (sign up then log in) work correctly.
    """
    conn = psycopg2.connect(_DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = False
    yield conn
    conn.rollback()
    conn.close()


@pytest.fixture
def client(db_conn):
    """
    A TestClient whose get_db dependency is overridden to use the per-test
    transactional connection. Deliberately omits commit so the db_conn
    fixture can roll everything back at teardown.

    TestClient is intentionally used without the context manager so the app's
    startup event (which has a retry loop) does not run — schema setup is
    handled by init_test_db instead.
    """
    def override_get_db():
        cur = db_conn.cursor()
        yield cur
        # No commit — db_conn fixture rolls the transaction back.

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app, raise_server_exceptions=True)
    app.dependency_overrides.clear()


@pytest.fixture
def alice(client):
    """A registered and authenticated user."""
    r = client.post("/auth/signup", json={"email": "alice@example.com", "password": "alicepw123"})
    assert r.status_code == 200
    return {"email": "alice@example.com", "token": r.json()["token"]}


@pytest.fixture
def bob(client):
    """A second registered user for multi-user isolation tests."""
    r = client.post("/auth/signup", json={"email": "bob@example.com", "password": "bobpw456"})
    assert r.status_code == 200
    return {"email": "bob@example.com", "token": r.json()["token"]}
