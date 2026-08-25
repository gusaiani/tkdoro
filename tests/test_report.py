"""Tests for the monthly report endpoint."""
import json
import time

from tests.helpers import auth_headers


def _seed_task_with_sessions(client, token, task_id, task_name, sessions):
    """Create a task with the given sessions via POST /data."""
    payload = {
        "tasks": [{"id": task_id, "name": task_name, "sessions": sessions}],
        "later": [],
    }
    r = client.post("/data", content=json.dumps(payload), headers=auth_headers(token))
    assert r.status_code == 204


def _ms_days_ago(days):
    """Return a millisecond timestamp for `days` days ago."""
    return int((time.time() - days * 86400) * 1000)


def test_report_requires_auth(client):
    r = client.get("/report/monthly")
    assert r.status_code in (401, 403)


def test_report_empty(client, alice):
    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["tasks"] == []
    assert body["total_ms"] == 0
    assert "period_start" in body
    assert "period_end" in body


def test_report_includes_recent_sessions(client, alice):
    """Sessions within the last 30 days appear in the report."""
    start = _ms_days_ago(5)
    end = start + 3600_000  # 1 hour

    _seed_task_with_sessions(client, alice["token"], "t1", "Write code", [
        {"start": start, "end": end},
    ])

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    assert len(body["tasks"]) == 1
    assert body["tasks"][0]["name"] == "Write code"
    assert body["tasks"][0]["total_ms"] == 3600_000
    assert body["tasks"][0]["session_count"] == 1
    assert body["total_ms"] == 3600_000


def test_report_excludes_old_sessions(client, alice, db_conn):
    """Sessions older than 30 days don't appear."""
    recent_start = _ms_days_ago(5)
    old_start = _ms_days_ago(45)

    payload = {
        "tasks": [
            {"id": "t1", "name": "Recent work", "sessions": [
                {"start": recent_start, "end": recent_start + 3600_000},
            ]},
            {"id": "t2", "name": "Old work", "sessions": [
                {"start": old_start, "end": old_start + 3600_000},
            ]},
        ],
        "later": [],
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    names = [t["name"] for t in body["tasks"]]
    assert "Recent work" in names
    assert "Old work" not in names


def test_report_aggregates_multiple_sessions(client, alice):
    """Multiple sessions on the same task are summed."""
    start1 = _ms_days_ago(3)
    start2 = _ms_days_ago(2)

    _seed_task_with_sessions(client, alice["token"], "t1", "Design", [
        {"start": start1, "end": start1 + 1800_000},  # 30 min
        {"start": start2, "end": start2 + 2700_000},  # 45 min
    ])

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    assert len(body["tasks"]) == 1
    assert body["tasks"][0]["total_ms"] == 4500_000
    assert body["tasks"][0]["session_count"] == 2
    assert body["total_ms"] == 4500_000


def test_report_sorted_by_duration_desc(client, alice):
    """Tasks are sorted longest-first."""
    start = _ms_days_ago(3)
    payload = {
        "tasks": [
            {"id": "t1", "name": "Short task", "sessions": [
                {"start": start, "end": start + 1000_000},
            ]},
            {"id": "t2", "name": "Long task", "sessions": [
                {"start": start, "end": start + 9000_000},
            ]},
        ],
        "later": [],
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    assert body["tasks"][0]["name"] == "Long task"
    assert body["tasks"][1]["name"] == "Short task"


def test_report_ignores_running_sessions(client, alice):
    """Sessions with end_ts = NULL (still running) are excluded from totals."""
    start = _ms_days_ago(1)
    _seed_task_with_sessions(client, alice["token"], "t1", "In progress", [
        {"start": start, "end": None},
    ])

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    assert body["tasks"] == []
    assert body["total_ms"] == 0


def test_report_no_overlap_total_with_concurrent_sessions(client, alice):
    """Overlapping sessions across tasks: total_ms sums them, no_overlap_ms merges them."""
    base = _ms_days_ago(2)
    payload = {
        "tasks": [
            {"id": "t1", "name": "Task A", "sessions": [
                {"start": base, "end": base + 3600_000},                 # 0h – 1h
            ]},
            {"id": "t2", "name": "Task B", "sessions": [
                {"start": base + 1800_000, "end": base + 5400_000},      # 0.5h – 1.5h
            ]},
        ],
        "later": [],
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    assert body["total_ms"] == 7200_000        # 1h + 1h, overlap double-counted
    assert body["no_overlap_ms"] == 5400_000   # union: 0h – 1.5h


def test_report_no_overlap_equals_total_when_sequential(client, alice):
    """Without concurrency the two totals are identical."""
    start1 = _ms_days_ago(3)
    start2 = start1 + 7200_000  # starts well after the first ends

    _seed_task_with_sessions(client, alice["token"], "t1", "Solo work", [
        {"start": start1, "end": start1 + 3600_000},
        {"start": start2, "end": start2 + 1800_000},
    ])

    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    body = r.json()
    assert body["total_ms"] == 5400_000
    assert body["no_overlap_ms"] == 5400_000


def test_report_no_overlap_empty(client, alice):
    r = client.get("/report/monthly", headers=auth_headers(alice["token"]))
    assert r.json()["no_overlap_ms"] == 0


def test_shared_report_includes_no_overlap_total(client, alice):
    """The shared read-only report exposes the same overlap-free total."""
    base = _ms_days_ago(2)
    payload = {
        "tasks": [
            {"id": "t1", "name": "Task A", "sessions": [
                {"start": base, "end": base + 3600_000},
            ]},
            {"id": "t2", "name": "Task B", "sessions": [
                {"start": base, "end": base + 3600_000},                 # fully concurrent
            ]},
        ],
        "later": [],
    }
    client.post("/data", content=json.dumps(payload), headers=auth_headers(alice["token"]))
    token = client.post("/share/enable", headers=auth_headers(alice["token"])).json()["share_token"]

    body = client.get(f"/shared/{token}/report/monthly").json()
    assert body["total_ms"] == 7200_000
    assert body["no_overlap_ms"] == 3600_000


def test_report_page_serves_html(client):
    r = client.get("/report")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]


def test_report_isolation(client, alice, bob):
    """Users only see their own data."""
    start = _ms_days_ago(3)
    _seed_task_with_sessions(client, alice["token"], "t1", "Alice task", [
        {"start": start, "end": start + 3600_000},
    ])
    _seed_task_with_sessions(client, bob["token"], "t1", "Bob task", [
        {"start": start, "end": start + 7200_000},
    ])

    alice_report = client.get("/report/monthly", headers=auth_headers(alice["token"])).json()
    assert len(alice_report["tasks"]) == 1
    assert alice_report["tasks"][0]["name"] == "Alice task"

    bob_report = client.get("/report/monthly", headers=auth_headers(bob["token"])).json()
    assert len(bob_report["tasks"]) == 1
    assert bob_report["tasks"][0]["name"] == "Bob task"
