"""/dashboard/nodes lists servers, not enrollments: re-enrolling a host leaves old decommissioned agent rows
behind, and each used to appear as its own node."""
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.main import app
from tests.test_dashboard_endpoints import (  # noqa: F401  (shared auth/DB overrides)
    mock_db, get_auth_headers, isolate_dashboard_tests,
)


def row(agent="agent-1", server="server-1", host="web-1", threats=0):
    return MagicMock(agent_id=agent, server_id=server, hostname=host, ip="10.0.0.1/32",
                     location="GB", agent_status="active", threats=threats)


async def get_nodes(monkeypatch, rows):
    seen = []

    def side_effect(statement, params=None, *a, **k):
        seen.append(str(statement))
        return MagicMock(fetchall=MagicMock(return_value=rows))

    mock_db.reset_mock()
    mock_db.execute.side_effect = side_effect
    redis = AsyncMock()
    redis.get.return_value = None
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kw: redis)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        r = await ac.get("/api/v1/dashboard/nodes", headers=get_auth_headers("client-a"))
    return r, seen


@pytest.mark.asyncio
async def test_node_carries_canonical_server_id(monkeypatch):
    r, _ = await get_nodes(monkeypatch, [row(agent="2a4f", server="9b97")])
    assert r.status_code == 200
    node = r.json()[0]
    assert node["id"] == "2a4f" and node["server_id"] == "9b97"


@pytest.mark.asyncio
async def test_query_picks_one_live_agent_per_server(monkeypatch):
    _, seen = await get_nodes(monkeypatch, [])
    sql = next(s for s in seen if "sentinel_agents" in s)
    assert "DISTINCT ON (s.id)" in sql                       # one row per server
    order = sql[sql.index("DISTINCT ON"):]
    # live agents beat offline beat decommissioned; newest wins ties
    assert order.index("'active'") < order.index("'degraded'") < order.index("'offline'")
    assert "a.updated_at DESC" in order
    assert sql.rstrip().endswith("hostname ASC") or "ORDER BY hostname" in sql  # still listed by hostname
