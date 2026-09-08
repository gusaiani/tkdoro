"""Tests for per-tag timesheet sharing (`/share/tags`, `/timesheet/{token}`)."""
import json
import time

from app import _period_bounds_ms, _summarize_tag_timesheet
from tests.helpers import auth_headers

HOUR = 3600_000
MINUTE = 60_000


def payload_with_tag(sessions_by_task=None, tag_name="acme", tag_id="p1"):
    """A POST /data payload with one tagged task and one untagged task."""
    sessions_by_task = sessions_by_task or {}
    return {
        "tasks": [
            {
                "id": "t1",
                "name": "Client work",
                "projectId": tag_id,
                "sessions": sessions_by_task.get("t1", []),
            },
            {
                "id": "t2",
                "name": "Personal admin",
                "projectId": None,
                "sessions": sessions_by_task.get("t2", []),
            },
        ],
        "later": [],
        "projects": [{"id": tag_id, "name": tag_name, "normalizedName": tag_name}],
    }


def post_data(client, user, payload):
    r = client.post(
        "/data",
        content=json.dumps(payload),
        headers={**auth_headers(user["token"]), "Content-Type": "application/json"},
    )
    assert r.status_code == 204
    return r


def enable_tag_share(client, user, tag_id="p1"):
    r = client.post(f"/share/tags/{tag_id}/enable", headers=auth_headers(user["token"]))
    assert r.status_code == 200
    return r.json()["token"]


# ── Period boundaries ────────────────────────────────────────────────────────

def test_period_bounds_week_starts_monday():
    # Wednesday 2026-09-09 12:00 UTC
    from datetime import datetime, timezone
    now_ms = int(datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
    bounds = _period_bounds_ms(0, now_ms)
    week_start = datetime.fromtimestamp(bounds["week"][0] / 1000, tz=timezone.utc)
    assert week_start.weekday() == 0          # Monday
    assert (week_start.year, week_start.month, week_start.day) == (2026, 9, 7)
    assert (week_start.hour, week_start.minute) == (0, 0)


def test_period_bounds_month_and_year_start():
    from datetime import datetime, timezone
    now_ms = int(datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
    bounds = _period_bounds_ms(0, now_ms)
    month_start = datetime.fromtimestamp(bounds["month"][0] / 1000, tz=timezone.utc)
    year_start = datetime.fromtimestamp(bounds["year"][0] / 1000, tz=timezone.utc)
    assert (month_start.month, month_start.day) == (9, 1)
    assert (year_start.month, year_start.day) == (1, 1)
    assert year_start.year == 2026


def test_period_bounds_respect_timezone_offset():
    """At 00:30 UTC on the 1st, a viewer at UTC-3 is still in the previous month."""
    from datetime import datetime, timezone
    now_ms = int(datetime(2026, 9, 1, 0, 30, tzinfo=timezone.utc).timestamp() * 1000)
    utc_month_start = _period_bounds_ms(0, now_ms)["month"][0]
    # getTimezoneOffset() is +180 for UTC-3
    brt_month_start = _period_bounds_ms(180, now_ms)["month"][0]
    assert utc_month_start > brt_month_start
    brt = datetime.fromtimestamp(brt_month_start / 1000, tz=timezone.utc)
    assert (brt.year, brt.month, brt.day, brt.hour) == (2026, 8, 1, 3)


# ── Aggregation ──────────────────────────────────────────────────────────────

def test_summary_clips_sessions_to_the_period():
    from datetime import datetime, timezone
    now_ms = int(datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc).timestamp() * 1000)
    week_start = _period_bounds_ms(0, now_ms)["week"][0]
    # One hour before the week started, one hour after
    sessions = [(week_start - HOUR, week_start + HOUR, "Client work")]
    summary = _summarize_tag_timesheet(sessions, 0, now_ms)
    assert summary["week"]["total_ms"] == HOUR
    assert summary["month"]["total_ms"] == 2 * HOUR


def test_summary_counts_open_sessions_up_to_now():
    now_ms = int(time.time() * 1000)
    summary = _summarize_tag_timesheet([(now_ms - 30 * MINUTE, None, "Client work")], 0, now_ms)
    assert summary["week"]["total_ms"] == 30 * MINUTE


def test_summary_reports_total_and_net_for_parallel_sessions():
    now_ms = int(time.time() * 1000)
    sessions = [
        (now_ms - 2 * HOUR, now_ms - HOUR, "Client work"),
        (now_ms - 2 * HOUR, now_ms - HOUR, "Client calls"),
    ]
    summary = _summarize_tag_timesheet(sessions, 0, now_ms)
    assert summary["week"]["total_ms"] == 2 * HOUR
    assert summary["week"]["net_ms"] == HOUR


def test_summary_breaks_down_by_task_and_by_day():
    now_ms = int(time.time() * 1000)
    sessions = [
        (now_ms - 2 * HOUR, now_ms - HOUR, "Client work"),
        (now_ms - 45 * MINUTE, now_ms - 30 * MINUTE, "Client calls"),
    ]
    summary = _summarize_tag_timesheet(sessions, 0, now_ms)
    tasks = {t["name"]: t["total_ms"] for t in summary["year"]["tasks"]}
    assert tasks == {"Client work": HOUR, "Client calls": 15 * MINUTE}
    assert summary["year"]["tasks"][0]["name"] == "Client work"  # sorted desc
    assert sum(d["total_ms"] for d in summary["days"]) == HOUR + 15 * MINUTE


# ── Enabling and disabling ───────────────────────────────────────────────────

def test_enable_tag_share_requires_auth(client):
    r = client.post("/share/tags/p1/enable")
    assert r.status_code in (401, 403)


def test_enable_tag_share_generates_token(client, alice):
    post_data(client, alice, payload_with_tag())
    r = client.post("/share/tags/p1/enable", headers=auth_headers(alice["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["project_id"] == "p1"
    assert len(body["token"]) == 36


def test_enable_tag_share_is_idempotent(client, alice):
    post_data(client, alice, payload_with_tag())
    first = enable_tag_share(client, alice)
    second = enable_tag_share(client, alice)
    assert first == second


def test_enable_unknown_tag_404(client, alice):
    post_data(client, alice, payload_with_tag())
    r = client.post("/share/tags/nope/enable", headers=auth_headers(alice["token"]))
    assert r.status_code == 404


def test_share_tags_lists_enabled_shares(client, alice):
    post_data(client, alice, payload_with_tag())
    token = enable_tag_share(client, alice)
    r = client.get("/share/tags", headers=auth_headers(alice["token"]))
    assert r.status_code == 200
    shares = r.json()["shares"]
    assert shares == [{"project_id": "p1", "tag": "acme", "token": token}]


def test_disable_tag_share_revokes_link(client, alice):
    post_data(client, alice, payload_with_tag())
    token = enable_tag_share(client, alice)
    assert client.get(f"/timesheet/{token}/data").status_code == 200
    r = client.post("/share/tags/p1/disable", headers=auth_headers(alice["token"]))
    assert r.status_code == 200
    assert client.get(f"/timesheet/{token}/data").status_code == 404


def test_deleting_the_tag_revokes_its_share(client, alice):
    post_data(client, alice, payload_with_tag())
    token = enable_tag_share(client, alice)
    untagged = payload_with_tag()
    untagged["tasks"][0]["projectId"] = None
    untagged["projects"] = []
    post_data(client, alice, untagged)
    assert client.get(f"/timesheet/{token}/data").status_code == 404


# ── Public timesheet endpoint ────────────────────────────────────────────────

def test_timesheet_reports_hours_for_the_tag(client, alice):
    now = int(time.time() * 1000)
    post_data(client, alice, payload_with_tag({
        "t1": [{"start": now - 2 * HOUR, "end": now - HOUR}],
        "t2": [{"start": now - 3 * HOUR, "end": now - 2 * HOUR}],
    }))
    token = enable_tag_share(client, alice)
    r = client.get(f"/timesheet/{token}/data?tz=0")
    assert r.status_code == 200
    body = r.json()
    assert body["tag"] == "acme"
    assert body["week"]["total_ms"] == HOUR
    assert body["month"]["total_ms"] == HOUR
    assert body["year"]["total_ms"] == HOUR
    # The untagged task is not part of this timesheet
    assert [t["name"] for t in body["week"]["tasks"]] == ["Client work"]


def test_timesheet_counts_a_running_session(client, alice):
    now = int(time.time() * 1000)
    post_data(client, alice, payload_with_tag({
        "t1": [{"start": now - 10 * MINUTE, "end": None}],
    }))
    token = enable_tag_share(client, alice)
    body = client.get(f"/timesheet/{token}/data?tz=0").json()
    assert body["running_count"] == 1
    assert body["week"]["total_ms"] >= 10 * MINUTE


def test_timesheet_needs_no_auth_and_hides_other_tags(client, alice, bob):
    now = int(time.time() * 1000)
    post_data(client, alice, payload_with_tag({
        "t1": [{"start": now - HOUR, "end": now}],
        "t2": [{"start": now - HOUR, "end": now}],
    }))
    post_data(client, bob, {
        "tasks": [{"id": "b1", "name": "Bob work", "projectId": "bp1",
                   "sessions": [{"start": now - HOUR, "end": now}]}],
        "later": [],
        "projects": [{"id": "bp1", "name": "acme", "normalizedName": "acme"}],
    })
    token = enable_tag_share(client, alice)
    body = client.get(f"/timesheet/{token}/data?tz=0").json()
    names = [t["name"] for t in body["year"]["tasks"]]
    assert names == ["Client work"]
    assert "Personal admin" not in names
    assert "Bob work" not in names


def test_timesheet_invalid_token_404(client):
    r = client.get("/timesheet/00000000-0000-0000-0000-000000000000/data")
    assert r.status_code == 404


def test_timesheet_page_serves_html(client, alice):
    post_data(client, alice, payload_with_tag())
    token = enable_tag_share(client, alice)
    r = client.get(f"/timesheet/{token}")
    assert r.status_code == 200
    assert "text/html" in r.headers["content-type"]
