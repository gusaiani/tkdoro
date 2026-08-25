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
    assert r.json() == {"tasks": [], "later": [], "theme": None, "projects": []}


def test_post_and_get_roundtrip(client, alice):
    now = 1_700_000_000_000
    payload = {"tasks": [{"id": "abc", "name": "Write tests", "sessions": [
        {"start": now, "end": now + 3600_000}
    ]}], "later": []}
    post_r = client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    assert post_r.status_code == 204

    get_r = client.get("/data", headers=auth_headers(alice["token"]))
    body = get_r.json()
    assert body["later"] == []
    assert len(body["tasks"]) == 1
    task = body["tasks"][0]
    assert task["id"] == "abc"
    assert task["name"] == "Write tests"
    assert len(task["sessions"]) == 1
    assert task["sessions"][0]["start"] == now
    assert task["sessions"][0]["end"] == now + 3600_000


def test_task_without_sessions_roundtrip(client, alice):
    payload = {"tasks": [{"id": "t1", "name": "No sessions yet", "sessions": []}], "later": []}
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    tasks = r.json()["tasks"]
    assert len(tasks) == 1
    assert tasks[0]["sessions"] == []


def test_live_session_round_trips_as_null_end(client, alice):
    now = 1_700_000_000_000
    payload = {"tasks": [{"id": "t1", "name": "Running", "sessions": [
        {"start": now, "end": None}
    ]}], "later": []}
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    session = r.json()["tasks"][0]["sessions"][0]
    assert session["start"] == now
    assert session["end"] is None


def test_concurrent_live_sessions_round_trip(client, alice):
    """Two tasks can have open (end=None) sessions at the same time."""
    now = 1_700_000_000_000
    payload = {"tasks": [
        {"id": "t1", "name": "Running A", "sessions": [{"start": now, "end": None}]},
        {"id": "t2", "name": "Running B", "sessions": [{"start": now + 60_000, "end": None}]},
    ], "later": []}
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    open_sessions = [s for t in r.json()["tasks"] for s in t["sessions"] if s["end"] is None]
    assert len(open_sessions) == 2


def test_post_overwrites_previous_data(client, alice):
    now = 1_700_000_000_000
    first  = {"tasks": [{"id": "1", "name": "First",  "sessions": [{"start": now, "end": now + 1000}]}], "later": []}
    second = {"tasks": [{"id": "2", "name": "Second", "sessions": []}], "later": []}
    client.post("/data", content=json.dumps(first),  headers=auth_headers(alice["token"]))
    client.post("/data", content=json.dumps(second), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    body = r.json()
    task_ids = [t["id"] for t in body["tasks"]]
    assert "2" in task_ids
    assert "1" not in task_ids


def test_data_is_isolated_between_users(client, alice, bob):
    now = 1_700_000_000_000
    alice_payload = {"tasks": [{"id": "secret", "name": "Alice's private task", "sessions": [
        {"start": now, "end": now + 3600_000}
    ]}], "later": []}
    bob_payload = {"tasks": [{"id": "bobs", "name": "Bob's task", "sessions": []}], "later": []}

    client.post("/data", content=json.dumps(alice_payload), headers=auth_headers(alice["token"]))

    # Bob sees his own empty list — not Alice's.
    r = client.get("/data", headers=auth_headers(bob["token"]))
    assert r.json() == {"tasks": [], "later": [], "theme": None, "projects": []}

    # Bob saves his own data — Alice's must be untouched.
    client.post("/data", content=json.dumps(bob_payload), headers=auth_headers(bob["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    body = r.json()
    task_ids = [t["id"] for t in body["tasks"]]
    assert "secret" in task_ids
    assert "bobs" not in task_ids


def test_later_items_round_trip(client, alice):
    payload = {
        "tasks": [],
        "later": [
            {"id": "l1", "text": "Buy milk"},
            {"id": "l2", "text": "Call dentist"},
        ],
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    body = r.json()
    assert body["later"] == [{"id": "l1", "text": "Buy milk"}, {"id": "l2", "text": "Call dentist"}]


def test_session_end_update(client, alice):
    """Ending a running session updates end_ts correctly."""
    now = 1_700_000_000_000
    running = {"tasks": [{"id": "t1", "name": "Task", "sessions": [{"start": now, "end": None}]}], "later": []}
    client.post("/data", content=json.dumps(running), headers=auth_headers(alice["token"]))

    ended = {"tasks": [{"id": "t1", "name": "Task", "sessions": [{"start": now, "end": now + 3600_000}]}], "later": []}
    client.post("/data", content=json.dumps(ended), headers=auth_headers(alice["token"]))

    r = client.get("/data", headers=auth_headers(alice["token"]))
    session = r.json()["tasks"][0]["sessions"][0]
    assert session["end"] == now + 3600_000


def test_projects_and_project_id_roundtrip(client, alice):
    """GET /data merges projects + projectId from user_data.tasks_json (same as POST body)."""
    projects = [
        {
            "id": "p1",
            "name": "Alpha",
            "normalizedName": "alpha",
            "createdAt": 1_700_000_000_000,
        },
    ]
    payload = {
        "tasks": [{"id": "t1", "name": "Write tests", "sessions": [], "projectId": "p1"}],
        "later": [],
        "projects": projects,
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    body = r.json()
    assert body["projects"] == projects
    assert body["tasks"][0]["projectId"] == "p1"


def test_project_id_not_merged_if_not_in_projects_list(client, alice):
    """Orphan projectId in blob is not applied (client would strip it anyway)."""
    payload = {
        "tasks": [{"id": "t1", "name": "Task", "sessions": [], "projectId": "ghost-id"}],
        "later": [],
        "projects": [],
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    r = client.get("/data", headers=auth_headers(alice["token"]))
    task = r.json()["tasks"][0]
    assert "projectId" not in task
