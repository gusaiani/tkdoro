import json

from tests.helpers import auth_headers


def test_get_without_auth_returns_403(client):
    r = client.get("/data")
    assert r.status_code == 403


def test_post_without_auth_returns_403(client):
    r = client.post("/data", content="{}")
    assert r.status_code == 403


def test_new_user_has_empty_task_list(client, alice):
    r = client.get("/data", headers=auth_headers(alice["token"]))
    assert r.status_code == 200
    assert r.json() == {"tasks": []}


def test_post_and_get_roundtrip(client, alice):
    tasks = {"tasks": [{"id": "abc", "name": "Write tests", "done": False}]}
    post_r = client.post(
        "/data",
        content=json.dumps(tasks),
        headers=auth_headers(alice["token"]),
    )
    assert post_r.status_code == 204

    get_r = client.get("/data", headers=auth_headers(alice["token"]))
    assert get_r.json() == tasks


def test_post_overwrites_previous_data(client, alice):
    first = {"tasks": [{"id": "1", "name": "First"}]}
    second = {"tasks": [{"id": "2", "name": "Second"}]}
    client.post("/data", content=json.dumps(first), headers=auth_headers(alice["token"]))
    client.post("/data", content=json.dumps(second), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    assert r.json() == second


def test_data_is_isolated_between_users(client, alice, bob):
    """A user must not be able to read or overwrite another user's data."""
    alice_tasks = {"tasks": [{"id": "secret", "name": "Alice's private task"}]}
    bob_tasks = {"tasks": [{"id": "bobs", "name": "Bob's task"}]}

    client.post("/data", content=json.dumps(alice_tasks), headers=auth_headers(alice["token"]))

    # Bob sees his own empty list — not Alice's.
    r = client.get("/data", headers=auth_headers(bob["token"]))
    assert r.json() == {"tasks": []}

    # Bob saves his own data — Alice's must be untouched.
    client.post("/data", content=json.dumps(bob_tasks), headers=auth_headers(bob["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    assert r.json() == alice_tasks
