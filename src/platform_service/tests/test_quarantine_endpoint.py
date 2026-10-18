import json
import httpx
import pytest
from unittest.mock import AsyncMock, MagicMock
from app.main import app
from app.api.v1.endpoints import dashboard
from tests.test_dashboard_endpoints import (  # reuse auth/DB overrides
    mock_db, get_auth_headers, isolate_dashboard_tests,  # noqa: F401
)

ALERT = "00000000-0000-0000-0000-0000000000a1"
SERVER = "11111111-1111-1111-1111-111111111111"
ALIAS = "22222222-2222-2222-2222-222222222222"
URL = f"/api/v1/dashboard/alerts/{ALERT}/quarantine"


class FakeRedis:
    def __init__(self):
        self.lists, self.ttls = {}, {}

    async def rpush(self, key, val):
        self.lists.setdefault(key, []).append(val)

    async def expire(self, key, ttl):
        self.ttls[key] = ttl

    async def aclose(self):
        pass


@pytest.fixture
def fake_redis(monkeypatch):
    r = FakeRedis()
    monkeypatch.setattr(dashboard.redis, "from_url", lambda *a, **k: r)
    return r


def wire_db(details, found=True, aliases=(ALIAS,)):
    stmts = []

    def side_effect(statement, params=None, *a, **k):
        s = str(statement).lower()
        stmts.append((s, params))
        if "tamper_alerts" in s:
            row = MagicMock(server_id=SERVER, details=details) if found else None
            return MagicMock(fetchone=MagicMock(return_value=row))
        if "server_aliases" in s:
            return MagicMock(fetchall=MagicMock(return_value=[MagicMock(alias_id=a) for a in aliases]))
        return MagicMock()

    mock_db.execute.side_effect = side_effect
    return stmts


async def post(slug="client-a"):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        return await ac.post(URL, headers=get_auth_headers(slug))


@pytest.mark.asyncio
async def test_quarantine_enqueues_for_server_and_aliases(fake_redis):
    stmts = wire_db({"pid": 4921, "exe": "/usr/bin/tail", "comm": "tail"})
    resp = await post()
    assert resp.status_code == 200
    assert resp.json()["status"] == "QUARANTINE_REQUESTED"
    for sid in (SERVER, ALIAS):
        key = f"pending_actions:client-a.{sid}"
        assert json.loads(fake_redis.lists[key][0]) == {
            "action": "KILL_PROCESS", "pid": 4921, "exe": "/usr/bin/tail", "alert_id": ALERT,
        }
        assert fake_redis.ttls[key] == 300
    insert = next(p for s, p in stmts if "insert into" in s and "alert_mitigations" in s)
    assert insert["pid"] == 4921 and insert["exe"] == "/usr/bin/tail"


@pytest.mark.asyncio
async def test_quarantine_missing_pid_400(fake_redis):
    wire_db({"exe": "/usr/bin/tail"})
    resp = await post()
    assert resp.status_code == 400
    assert not fake_redis.lists


@pytest.mark.asyncio
async def test_quarantine_missing_exe_400(fake_redis):
    wire_db({"pid": 4921})
    assert (await post()).status_code == 400


@pytest.mark.asyncio
async def test_quarantine_alert_not_found_404(fake_redis):
    wire_db({}, found=False)
    resp = await post()
    assert resp.status_code == 404
    assert "alert not found" in resp.json()["detail"].lower()
    assert not fake_redis.lists


@pytest.mark.asyncio
async def test_get_alerts_includes_mitigation_status():
    row = MagicMock(
        id=ALERT, server_id=SERVER, hostname="h", event_type="DECOY_TAMPER", severity="critical",
        details={}, detected_at="2026-10-18", status="QUARANTINE_REQUESTED", mitigation_notes=None,
    )
    seen = []

    def side_effect(statement, params=None, *a, **k):
        seen.append(str(statement).lower())
        return MagicMock(fetchall=MagicMock(return_value=[row]))

    mock_db.execute.side_effect = side_effect
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/dashboard/alerts", headers=get_auth_headers("client-a"))
    assert resp.status_code == 200
    assert resp.json()["data"][0]["status"] == "QUARANTINE_REQUESTED"
    assert any("left join" in s and "alert_mitigations" in s for s in seen)


PARENT = {"pid": 4921, "exe": "/usr/bin/cat", "ppid": 3250287, "parent_comm": "bash"}


async def post_json(body):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        return await ac.post(URL, json=body, headers=get_auth_headers("client-a"))


@pytest.mark.asyncio
async def test_kill_parent_adds_parent_to_queued_action(fake_redis):
    wire_db(PARENT)
    resp = await post_json({"kill_parent": True})
    assert resp.status_code == 200
    queued = json.loads(fake_redis.lists[f"pending_actions:client-a.{SERVER}"][0])
    assert queued["ppid"] == 3250287 and queued["parent_comm"] == "bash" and queued["pid"] == 4921


@pytest.mark.asyncio
async def test_parent_not_included_by_default(fake_redis):
    wire_db(PARENT)
    assert (await post()).status_code == 200            # no body at all
    assert (await post_json({"kill_parent": False})).status_code == 200
    for raw in fake_redis.lists[f"pending_actions:client-a.{SERVER}"]:
        assert "ppid" not in json.loads(raw)


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["ppid", "parent_comm"])
async def test_kill_parent_without_recorded_parent_is_400(fake_redis, missing):
    d = {k: v for k, v in PARENT.items() if k != missing}
    wire_db(d)
    resp = await post_json({"kill_parent": True})
    assert resp.status_code == 400 and not fake_redis.lists


@pytest.mark.asyncio
@pytest.mark.parametrize("ppid", [0, 1, "300", True, None])
async def test_kill_parent_rejects_unsafe_ppid(fake_redis, ppid):
    wire_db({**PARENT, "ppid": ppid})
    assert (await post_json({"kill_parent": True})).status_code == 400
