"""Internal sentinel-facing route: list a server's planted/tampered canaries for cleanup.

Called only by the ingestion service (which derives slug/server from the verified mTLS cert),
guarded by a shared X-Internal-Token. Negative cases first.
"""
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest

from app.main import app
from app.core.config import settings
from app.core.database import get_db_session

TOKEN = "internal-test-token-0123456789abcdef"
SID = str(uuid.uuid4())
URL = f"/internal/v1/tenants/acme/servers/{SID}/canaries"


class FakeSession:
    """Records executed SQL; returns canned rows for the canary query."""

    def __init__(self, rows=None, fail=None):
        self.calls = []
        self.rows = rows or []
        self.fail = fail

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.calls.append((sql, params or {}))
        if "SET search_path" in sql:
            return MagicMock()
        if self.fail:
            raise self.fail
        res = MagicMock()
        res.fetchall.return_value = self.rows
        return res

    def canary_queries(self):
        return [(s, p) for s, p in self.calls if "canary_decoy_files" in s]


@pytest.fixture
def session():
    s = FakeSession()

    async def override():
        yield s

    app.dependency_overrides[get_db_session] = override
    yield s
    app.dependency_overrides.pop(get_db_session, None)


@pytest.fixture(autouse=True)
def configured_token(monkeypatch):
    monkeypatch.setattr(settings, "INTERNAL_API_TOKEN", TOKEN, raising=False)


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def row(path="/opt/app/keys/id_rsa.bak", status="planted", dtype="ssh_key"):
    return SimpleNamespace(id=uuid.uuid4(), file_path=path, decoy_type=dtype, original_hash="a" * 64, status=status)


# ---------------------------------------------------------------- auth: negative

@pytest.mark.asyncio
async def test_missing_token_is_unauthorized(session):
    async with client() as c:
        r = await c.get(URL)
    assert r.status_code == 401
    assert session.calls == [], "must not touch the DB before authenticating"


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["wrong", TOKEN[:-1], TOKEN + "x", TOKEN.upper(), " " + TOKEN, ""])
async def test_wrong_token_is_forbidden(session, bad):
    async with client() as c:
        r = await c.get(URL, headers={"X-Internal-Token": bad})
    assert r.status_code in (401, 403)
    assert session.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("configured", ["", None])
@pytest.mark.parametrize("sent", ["", "anything", "None"])
async def test_unset_server_token_fails_closed(session, monkeypatch, configured, sent):
    monkeypatch.setattr(settings, "INTERNAL_API_TOKEN", configured, raising=False)
    async with client() as c:
        r = await c.get(URL, headers={"X-Internal-Token": sent})
    assert r.status_code in (401, 403, 503)
    assert session.calls == []


@pytest.mark.asyncio
async def test_bearer_user_jwt_is_not_a_substitute(session):
    async with client() as c:
        r = await c.get(URL, headers={"Authorization": "Bearer abc"})
    assert r.status_code in (401, 403)
    assert session.calls == []


@pytest.mark.asyncio
async def test_token_in_query_string_is_ignored(session):
    async with client() as c:
        r = await c.get(URL, params={"X-Internal-Token": TOKEN, "token": TOKEN})
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_post_not_allowed(session):
    async with client() as c:
        r = await c.post(URL, headers={"X-Internal-Token": TOKEN})
    assert r.status_code == 405


# ---------------------------------------------------------------- input validation: negative

@pytest.mark.asyncio
@pytest.mark.parametrize("slug", ["a%3Bb", "a%20b", "x%27%20OR%201%3D1--", "..%2F..", "gl%00obal"])
async def test_malicious_slug_rejected_before_db(session, slug):
    async with client() as c:
        r = await c.get(f"/internal/v1/tenants/{slug}/servers/{SID}/canaries", headers={"X-Internal-Token": TOKEN})
    assert r.status_code in (400, 404, 422)
    assert all("canary_decoy_files" not in s for s, _ in session.calls)


@pytest.mark.asyncio
async def test_global_slug_rejected(session):
    async with client() as c:
        r = await c.get(f"/internal/v1/tenants/global/servers/{SID}/canaries", headers={"X-Internal-Token": TOKEN})
    assert r.status_code == 400
    assert session.canary_queries() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("sid", ["not-a-uuid", "1", "' OR '1'='1", "00000000-0000-0000-0000-00000000000g"])
async def test_non_uuid_server_id_rejected(session, sid):
    async with client() as c:
        r = await c.get(f"/internal/v1/tenants/acme/servers/{sid}/canaries", headers={"X-Internal-Token": TOKEN})
    assert r.status_code in (400, 404, 422)
    assert session.canary_queries() == []


# ---------------------------------------------------------------- data behaviour

@pytest.mark.asyncio
async def test_unknown_server_returns_empty_list_not_error(session):
    session.rows = []
    async with client() as c:
        r = await c.get(URL, headers={"X-Internal-Token": TOKEN})
    assert r.status_code == 200
    assert r.json() == {"canaries": []}


@pytest.mark.asyncio
async def test_query_only_selects_live_statuses(session):
    async with client() as c:
        await c.get(URL, headers={"X-Internal-Token": TOKEN})
    (sql, _), = session.canary_queries()
    low = sql.lower()
    assert "planted" in low and "tampered" in low and "orphaned" in low
    assert "cleaned_up" not in low and "verification_failed" not in low


@pytest.mark.asyncio
async def test_query_does_not_use_any_alias_lookup(session):
    async with client() as c:
        await c.get(URL, headers={"X-Internal-Token": TOKEN})
    (sql, _), = session.canary_queries()
    assert "alias" not in sql.lower()


@pytest.mark.asyncio
async def test_query_is_scoped_to_server_via_bound_parameter(session):
    async with client() as c:
        await c.get(URL, headers={"X-Internal-Token": TOKEN})
    (sql, params), = session.canary_queries()
    assert "server_id" in sql
    assert SID not in sql, "server id must be a bound parameter, never interpolated into SQL"
    assert SID in params.values()


@pytest.mark.asyncio
async def test_search_path_is_set_to_the_path_tenant(session):
    async with client() as c:
        await c.get(URL, headers={"X-Internal-Token": TOKEN})
    assert any("client_acme" in s for s, _ in session.calls if "SET search_path" in s)


@pytest.mark.asyncio
async def test_db_error_returns_500_without_leaking_details(session):
    session.fail = RuntimeError("secret-db-detail: relation client_acme.canary_decoy_files")
    async with client() as c:
        r = await c.get(URL, headers={"X-Internal-Token": TOKEN})
    assert r.status_code == 500
    body = r.text
    assert "secret-db-detail" not in body and "canary_decoy_files" not in body


@pytest.mark.asyncio
async def test_token_never_echoed_in_response(session):
    session.rows = [row()]
    async with client() as c:
        r = await c.get(URL, headers={"X-Internal-Token": TOKEN})
    assert TOKEN not in r.text


@pytest.mark.asyncio
async def test_lists_rows_with_expected_shape(session):
    a, b = row("/opt/app/keys/id_rsa.bak", "planted"), row("/opt/app/configs/.env.staging", "tampered", "env_file")
    session.rows = [a, b]
    async with client() as c:
        r = await c.get(URL, headers={"X-Internal-Token": TOKEN})
    assert r.status_code == 200
    items = r.json()["canaries"]
    assert [i["id"] for i in items] == [str(a.id), str(b.id)]
    assert items[0] == {"id": str(a.id), "path": a.file_path, "type": "ssh_key", "sha256": "a" * 64, "status": "planted"}
    assert items[1]["status"] == "tampered"
