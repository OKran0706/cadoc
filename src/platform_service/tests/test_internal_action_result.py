"""Internal route: sentinel's quarantine result (relayed by ingestion) -> alert_mitigations status."""
import uuid
from unittest.mock import MagicMock

import httpx
import pytest

from app.main import app
from app.core.config import settings
from app.core.database import get_db_session

TOKEN = "internal-test-token-0123456789abcdef"
SID = str(uuid.uuid4())
ALERT = str(uuid.uuid4())
URL = f"/internal/v1/tenants/acme/servers/{SID}/actions/result"
H = {"X-Internal-Token": TOKEN}


class FakeSession:
    def __init__(self, rowcount=1):
        self.calls, self.rowcount = [], rowcount

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.calls.append((sql, params or {}))
        res = MagicMock()
        res.rowcount = self.rowcount if "alert_mitigations" in sql else 0
        return res

    async def commit(self):
        pass

    def updates(self):
        return [(s, p) for s, p in self.calls if "alert_mitigations" in s]


@pytest.fixture
def session():
    s = FakeSession()

    async def override():
        yield s

    app.dependency_overrides[get_db_session] = override
    yield s
    app.dependency_overrides.pop(get_db_session, None)


@pytest.fixture(autouse=True)
def token(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_API_TOKEN", TOKEN, raising=False)


async def post(body, headers=H, url=URL):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        return await c.post(url, json=body, headers=headers)


@pytest.mark.asyncio
async def test_requires_internal_token(session):
    r = await post({"alert_id": ALERT, "ok": True, "message": "x"}, headers={})
    assert r.status_code == 401 and session.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [{}, {"alert_id": "nope", "ok": True}, {"alert_id": ALERT}, {"ok": True}])
async def test_bad_body_422(session, body):
    assert (await post(body)).status_code == 422
    assert session.updates() == []


@pytest.mark.asyncio
async def test_global_slug_rejected(session):
    r = await post({"alert_id": ALERT, "ok": True}, url=f"/internal/v1/tenants/global/servers/{SID}/actions/result")
    assert r.status_code == 400 and session.updates() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("ok,status", [(True, "QUARANTINED"), (False, "QUARANTINE_FAILED")])
async def test_sets_status_only_for_this_servers_pending_alert(session, ok, status):
    r = await post({"alert_id": ALERT, "ok": ok, "message": "killed pid 4921"})
    assert r.status_code == 200 and r.json() == {"updated": 1}
    sql, params = session.updates()[0]
    assert params["status"] == status and params["aid"] == ALERT and params["sid"] == SID
    assert "QUARANTINE_REQUESTED" in sql          # cannot overwrite other states
    assert "server_aliases" in sql and "server_id" in sql  # alert must belong to the calling server


@pytest.mark.asyncio
async def test_message_truncated(session):
    await post({"alert_id": ALERT, "ok": False, "message": "x" * 5000})
    assert len(session.updates()[0][1]["msg"]) <= 300
