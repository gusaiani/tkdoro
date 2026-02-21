"""
Unit tests for JWT and password helpers.

The pure crypto tests (hash/verify/make_token) require no database or HTTP
stack. The JWT boundary tests (expired, wrong secret, malformed) exercise the
full HTTP path to verify that the app correctly rejects bad tokens at the edge.
"""
import os
from datetime import datetime, timedelta, timezone

from jose import jwt

from app import hash_password, make_token, verify_password


# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

def test_hash_is_not_stored_as_plaintext():
    assert hash_password("mypassword") != "mypassword"


def test_hash_uses_bcrypt_format():
    # bcrypt hashes always start with the $2b$ version identifier
    assert hash_password("x").startswith("$2b$")


def test_verify_correct_password_returns_true():
    hashed = hash_password("correct")
    assert verify_password("correct", hashed)


def test_verify_wrong_password_returns_false():
    hashed = hash_password("correct")
    assert not verify_password("wrong", hashed)


def test_two_hashes_of_same_password_differ():
    """bcrypt generates a random salt per call — equal inputs must not produce equal hashes."""
    assert hash_password("pw") != hash_password("pw")


# ---------------------------------------------------------------------------
# JWT generation
# ---------------------------------------------------------------------------

def test_make_token_encodes_user_id_as_sub():
    token = make_token(42)
    claims = jwt.decode(token, os.environ["SECRET_KEY"], algorithms=["HS256"])
    assert claims["sub"] == "42"


def test_make_token_includes_expiry():
    token = make_token(1)
    claims = jwt.decode(token, os.environ["SECRET_KEY"], algorithms=["HS256"])
    assert "exp" in claims


# ---------------------------------------------------------------------------
# JWT rejection at the HTTP boundary
# ---------------------------------------------------------------------------

def test_expired_token_is_rejected(client):
    expired = jwt.encode(
        {"sub": "1", "exp": datetime.now(timezone.utc) - timedelta(seconds=1)},
        os.environ["SECRET_KEY"],
        algorithm="HS256",
    )
    r = client.get("/data", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401


def test_token_signed_with_wrong_secret_is_rejected(client):
    token = jwt.encode({"sub": "1"}, "wrong-secret", algorithm="HS256")
    r = client.get("/data", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_malformed_token_is_rejected(client):
    r = client.get("/data", headers={"Authorization": "Bearer not.a.real.token"})
    assert r.status_code == 401
