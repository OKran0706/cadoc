"""A re-added server is merged into its earlier record: the sentinel/agent id the UI shows is an alias
(server_aliases) of the canonical servers.id that decoys and alerts are stored under. Client-supplied
server_id filters must resolve to the canonical id before comparing."""
import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.main import app
from app.core import database
from app.core.database import canonical_server_sql, get_db_session
from tests.test_dashboard_endpoints import (  # noqa: F401  (shared auth/DB overrides)
    mock_db, get_auth_headers, isolate_dashboard_tests,
)

AGENT = "2a4f6f1b-dd46-4fea-a80f-5d3e41b60f1d"
SERVER = "9b97b6cc-d3b6-48f8-9894-cab6c9d6cbe2"


def test_fragment_checks_aliases_then_agents_then_falls_back_to_input():
    sql = canonical_server_sql("acme", "sid")
    assert sql.index("server_aliases") < sql.index("sentinel_agents") < sql.rindex("CAST(:sid AS uuid)")
    assert '"client_acme".server_aliases' in sql and '"client_acme".sentinel_agents' in sql


@pytest.mark.parametrize("slug", ["", "a;b", 'a"b', "x y", "../x"])
def test_fragment_rejects_unsafe_slug(slug):
    with pytest.raises(ValueError):
        canonical_server_sql(slug, "sid")


@pytest.mark.asyncio
async def test_list_decoys_filter_resolves_alias_in_sql():
    mock_db.reset_mock()
    mock_db.execute.side_effect = None
    mock_db.execute.return_value = MagicMock(fetchall=MagicMock(return_value=[]), scalar=MagicMock(return_value="x"))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.get(f"/api/v1/decoys/?server_id={AGENT}", headers=get_auth_headers("client-a"))
    assert r.status_code == 200
    q = [c for c in mock_db.execute.call_args_list if "canary_decoy_files" in str(c.args[0])][-1]
    sql = str(q.args[0])
    assert "server_aliases" in sql and "sentinel_agents" in sql
    assert q.args[1] == {"server_id": AGENT}  # still bound, never interpolated


async def _stream(monkeypatch, filter_id, resolver):
    mock_redis, pubsub = AsyncMock(), AsyncMock()
    pubsub.get_message.side_effect = [
        {"type": "message", "data": json.dumps({"type": "heartbeat", "server_id": "other"})},
        {"type": "message", "data": json.dumps({"type": "alert", "server_id": SERVER})},
        None,
    ]
    mock_redis.pubsub = MagicMock(return_value=pubsub)
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kw: mock_redis)
    from fastapi import Request
    monkeypatch.setattr(Request, "is_disconnected", AsyncMock(side_effect=[False, False, True]))
    import asyncio

    async def no_sleep(_):
        return
    monkeypatch.setattr(asyncio, "sleep", no_sleep)
    monkeypatch.setattr("app.api.v1.endpoints.dashboard.canonical_server_id", resolver)
    seen = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        async with ac.stream("GET", f"/api/v1/dashboard/alerts/stream?server_id={filter_id}",
                             headers=get_auth_headers("client-a")) as r:
            assert r.status_code == 200
            async for line in r.aiter_lines():
                if line.startswith("data:"):
                    seen.append(json.loads(line[5:]))
    return seen


@pytest.mark.asyncio
async def test_stream_filter_by_agent_id_matches_canonical_server_events(monkeypatch):
    async def resolver(slug, sid):
        assert slug == "client-a" and sid == AGENT
        return SERVER
    seen = await _stream(monkeypatch, AGENT, resolver)
    assert [m["server_id"] for m in seen] == [SERVER]


@pytest.mark.asyncio
async def test_stream_filter_survives_resolver_failure(monkeypatch):
    async def boom(slug, sid):
        raise RuntimeError("db down")
    seen = await _stream(monkeypatch, SERVER, boom)  # falls back to the id as given
    assert [m["server_id"] for m in seen] == [SERVER]
