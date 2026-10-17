"""Heartbeats are keyed by the sentinel (agent) id. After a re-added server is merged the agent
id differs from the server id, so the live stream must report the real server."""
import asyncio
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest

from app.services import stream

AGENT = "11111111-1111-4111-8111-111111111111"
SERVER = "33333333-3333-4333-8333-333333333333"


class FakeSession:
    def __init__(self, agent_server=None, hostname="old-box.int", fail=False):
        self.calls, self.agent_server, self.hostname, self.fail = [], agent_server, hostname, fail

    async def execute(self, stmt, params=None):
        if self.fail:
            raise RuntimeError("db down")
        sql = str(stmt)
        self.calls.append((sql, params or {}))
        res = MagicMock()
        if "sentinel_agents" in sql:
            res.fetchone.return_value = MagicMock(server_id=self.agent_server) if self.agent_server else None
        else:
            res.fetchone.return_value = MagicMock(hostname=self.hostname)
        return res


@pytest.fixture
def captured(monkeypatch):
    sent = []
    stream._hostnames.clear()
    stream._agent_servers.clear()

    class FakeRedis:
        async def publish(self, ch, msg):
            sent.append((ch, msg))

        async def close(self):
            pass

    monkeypatch.setattr(stream.redis, "from_url", lambda *a, **k: FakeRedis())
    return sent


def go(session, payload, monkeypatch):
    @asynccontextmanager
    async def factory():
        yield session

    monkeypatch.setattr(stream, "async_session_factory", factory)
    asyncio.run(stream.publish("acme", payload))


def test_heartbeat_server_id_is_resolved_from_the_agent(monkeypatch, captured):
    import json
    s = FakeSession(agent_server=SERVER)
    go(s, {"type": "heartbeat", "server_id": AGENT, "status": "active"}, monkeypatch)
    msg = json.loads(captured[0][1])
    assert msg["server_id"] == SERVER and msg["hostname"] == "old-box.int"
    host_q = [p for sql, p in s.calls if "servers" in sql and "sentinel_agents" not in sql]
    assert host_q and host_q[0]["id"] == SERVER, "hostname must be looked up for the real server"


def test_heartbeat_without_agent_row_keeps_the_id(monkeypatch, captured):
    import json
    go(FakeSession(agent_server=None), {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    assert json.loads(captured[0][1])["server_id"] == AGENT


def test_resolution_failure_still_publishes_unchanged(monkeypatch, captured):
    import json
    go(FakeSession(fail=True), {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    assert json.loads(captured[0][1])["server_id"] == AGENT


def test_non_heartbeat_events_are_not_remapped(monkeypatch, captured):
    import json
    s = FakeSession(agent_server=SERVER)
    go(s, {"type": "alert", "server_id": AGENT, "event_type": "DECOY_TAMPER"}, monkeypatch)
    assert json.loads(captured[0][1])["server_id"] == AGENT
    assert not [1 for sql, _ in s.calls if "sentinel_agents" in sql]


def test_resolution_query_is_scoped_and_bound(monkeypatch, captured):
    s = FakeSession(agent_server=SERVER)
    go(s, {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    sql, params = [c for c in s.calls if "sentinel_agents" in c[0]][0]
    assert '"client_acme"' in sql and AGENT not in sql and params["id"] == AGENT


def test_unsafe_slug_never_queries(monkeypatch, captured):
    s = FakeSession(agent_server=SERVER)

    @asynccontextmanager
    async def factory():
        yield s

    monkeypatch.setattr(stream, "async_session_factory", factory)
    asyncio.run(stream.publish("a'; drop", {"type": "heartbeat", "server_id": AGENT}))
    assert s.calls == []


# ---------------------------------------------------------------- cache with short TTL

def test_agent_lookup_is_cached_between_heartbeats(monkeypatch, captured):
    stream._agent_servers.clear()
    s = FakeSession(agent_server=SERVER)
    go(s, {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    go(s, {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    assert len([1 for sql, _ in s.calls if "sentinel_agents" in sql]) == 1


def test_agent_cache_expires_so_a_merge_shows_up(monkeypatch, captured):
    import json
    stream._agent_servers.clear()
    now = [1000.0]
    monkeypatch.setattr(stream.time, "monotonic", lambda: now[0])
    s = FakeSession(agent_server=AGENT)               # before the merge: agent == server
    go(s, {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    s.agent_server = SERVER                           # merge re-points the agent
    now[0] += stream._AGENT_TTL + 1
    go(s, {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    assert json.loads(captured[-1][1])["server_id"] == SERVER


def test_failed_lookups_are_not_cached(monkeypatch, captured):
    stream._agent_servers.clear()
    go(FakeSession(fail=True), {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    s = FakeSession(agent_server=SERVER)
    go(s, {"type": "heartbeat", "server_id": AGENT}, monkeypatch)
    assert len([1 for sql, _ in s.calls if "sentinel_agents" in sql]) == 1


def test_cache_is_per_tenant(monkeypatch, captured):
    stream._agent_servers.clear()
    s = FakeSession(agent_server=SERVER)

    @asynccontextmanager
    async def factory():
        yield s

    monkeypatch.setattr(stream, "async_session_factory", factory)
    asyncio.run(stream.publish("acme", {"type": "heartbeat", "server_id": AGENT}))
    asyncio.run(stream.publish("globex", {"type": "heartbeat", "server_id": AGENT}))
    assert len([1 for sql, _ in s.calls if "sentinel_agents" in sql]) == 2
