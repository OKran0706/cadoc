"""/dashboard/servers/verify must report the server's LIVE agent. After a re-added machine is merged
into its earlier record, the server has several agent rows (older ones are 'decommissioned'); the
status shown to the user must not be an arbitrary one of them."""
import asyncio
import re
from unittest.mock import MagicMock

from app.api.v1.endpoints import dashboard

SERVER = "33333333-3333-4333-8333-333333333333"
CLAIMS = {"company_slug": "acme"}


class FakeSession:
    def __init__(self, server=True, agent_status=None):
        self.calls = []
        self.server, self.agent_status = server, agent_status

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.calls.append((sql, params or {}))
        res = MagicMock()
        if "sentinel_agents" in sql:
            res.fetchone.return_value = MagicMock(id="a", status=self.agent_status) if self.agent_status else None
        elif ".servers" in sql:
            res.fetchone.return_value = MagicMock(id=SERVER) if self.server else None
        return res


def verify(session):
    req = dashboard.VerifyRequest(server_id=SERVER)
    return asyncio.run(dashboard.verify_server_registration(req, db=session, admin_claims=CLAIMS))


def agent_sql(s):
    return [sql for sql, _ in s.calls if "sentinel_agents" in sql][0]


# ---------------------------------------------------------------- negative

def test_unknown_server_is_not_registered_and_never_queries_agents():
    s = FakeSession(server=False)
    r = verify(s)
    assert (r.verified, r.status) == (False, "not_registered")
    assert not [1 for sql, _ in s.calls if "sentinel_agents" in sql]


def test_server_without_agents_is_not_registered():
    r = verify(FakeSession(agent_status=None))
    assert (r.verified, r.status) == (False, "not_registered")


def test_only_decommissioned_agents_report_decommissioned_unverified():
    r = verify(FakeSession(agent_status="decommissioned"))
    assert (r.verified, r.status) == (False, "decommissioned")


def test_offline_agent_is_not_verified():
    r = verify(FakeSession(agent_status="offline"))
    assert (r.verified, r.status) == (False, "offline")


def test_server_id_is_a_bound_parameter():
    s = FakeSession(agent_status="active")
    verify(s)
    sql = agent_sql(s)
    assert SERVER not in sql
    assert any(p.get("server_id") == SERVER for q, p in s.calls if "sentinel_agents" in q)


# ---------------------------------------------------------------- the fix: pick the live agent

def test_agent_query_prefers_active_over_decommissioned():
    s = FakeSession(agent_status="active")
    verify(s)
    sql = re.sub(r"\s+", " ", agent_sql(s))
    m = re.search(r"ORDER BY CASE status (.*?) END", sql)
    assert m, "agent lookup must be ordered, not an arbitrary LIMIT 1: " + sql
    ranks = dict((k, int(v)) for k, v in re.findall(r"WHEN '(\w+)' THEN (\d+)", m.group(1)))
    assert ranks["active"] < ranks["degraded"] < ranks["offline"], ranks
    assert ranks["offline"] < 3, "ELSE branch (decommissioned) must rank last"
    assert "ELSE 3" in m.group(1) and "decommissioned" not in ranks
    assert sql.rstrip().endswith("LIMIT 1")


def test_ties_prefer_the_most_recently_updated_agent():
    s = FakeSession(agent_status="active")
    verify(s)
    assert re.search(r"updated_at DESC\s+LIMIT 1", re.sub(r"\s+", " ", agent_sql(s)))


def test_active_agent_verifies():
    r = verify(FakeSession(agent_status="active"))
    assert (r.verified, r.status) == (True, "active")
