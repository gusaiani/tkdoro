import os

from jose import jwt


def test_signup_returns_token(client):
    r = client.post("/auth/signup", json={"email": "new@example.com", "password": "secret"})
    assert r.status_code == 200
    assert "token" in r.json()


def test_signup_duplicate_email_returns_409(client):
    payload = {"email": "dup@example.com", "password": "secret"}
    client.post("/auth/signup", json=payload)
    r = client.post("/auth/signup", json=payload)
    assert r.status_code == 409


def test_login_with_correct_credentials_returns_token(client):
    payload = {"email": "login@example.com", "password": "secret"}
    client.post("/auth/signup", json=payload)
    r = client.post("/auth/login", json=payload)
    assert r.status_code == 200
    assert "token" in r.json()


def test_login_with_wrong_password_returns_401(client):
    client.post("/auth/signup", json={"email": "wp@example.com", "password": "correct"})
    r = client.post("/auth/login", json={"email": "wp@example.com", "password": "wrong"})
    assert r.status_code == 401


def test_login_with_unknown_email_returns_401(client):
    r = client.post("/auth/login", json={"email": "ghost@example.com", "password": "pw"})
    assert r.status_code == 401


def test_tokens_are_valid_jwts_with_correct_claims(client):
    """Tokens from both signup and login must carry numeric sub and exp claims."""
    payload = {"email": "jwt@example.com", "password": "pw"}
    signup_r = client.post("/auth/signup", json=payload)
    login_r = client.post("/auth/login", json=payload)

    for response in [signup_r, login_r]:
        token = response.json()["token"]
        claims = jwt.decode(token, os.environ["SECRET_KEY"], algorithms=["HS256"])
        assert "sub" in claims
        assert "exp" in claims
        assert claims["sub"].isdigit()
