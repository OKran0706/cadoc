"""
test_e2e_flows.py
=================
End-to-end FLOW tests for the Platform Service.

Each test exercises a complete multi-step scenario rather than individual
endpoints in isolation. The goals are:

1. Tenant Lifecycle Flow
   provision → create project → register server → brokered join → list agents
   → decommission agent → recommission agent

2. Cross-Tenant Isolation Flow
   Tenant A creates resources; Tenant B cannot see / access them (404 policy).

3. Project + Server CRUD Flows
   create → list → duplicate detection (409) → error paths (500).

4. Agent Management Flows
   list → decommission → recommission → scope-guard checks.

5. Global-Admin Delegation Flows
   Global admin uses company_slug param to act on behalf of a tenant.

All tests use httpx.AsyncClient against the real FastAPI app with DB and
permission dependencies mocked — the same pattern established in
test_coverage_expansion.py.
"""

import pytest
import jwt
import json
import httpx
from unittest.mock import AsyncMock, MagicMock, patch, call
from fastapi import Request, HTTPException

from app.main import app
from app.core.config import settings
from app.core.database import get_db_session
from app.core.security import RequirePermission, verify_user_jwt

# ---------------------------------------------------------------------------
# ── Shared mock database & fixture plumbing ─────────────────────────────────
# ---------------------------------------------------------------------------

mock_db = AsyncMock()


async def override_get_db():
    yield mock_db


# Default tenant permission context – Tenant "client-a"
async def _perm_client_a(self, request: Request, db=None, api_key=None, credentials=None):
    return {"user_id": "user-a", "company_slug": "client-a", "tenant_id": "tenant-a-uuid"}


# Alternate tenant permission context – Tenant "client-b"
async def _perm_client_b(self, request: Request, db=None, api_key=None, credentials=None):
    return {"user_id": "user-b", "company_slug": "client-b", "tenant_id": "tenant-b-uuid"}


# Global admin permission context
async def _perm_global(self, request: Request, db=None, api_key=None, credentials=None):
    return {"user_id": "admin-global", "company_slug": "global", "tenant_id": None}


# JWT override for "client-a"
async def _jwt_client_a(request: Request = None, credentials=None):
    return {"sub": "user-a", "company_slug": "client-a", "tenant_id": "tenant-a-uuid"}


# JWT override for "global"
async def _jwt_global(request: Request = None, credentials=None):
    return {"sub": "admin-global", "company_slug": "global", "tenant_id": None}


_orig_require_permission_call = RequirePermission.__call__


@pytest.fixture(autouse=True)
def reset_mocks_and_overrides():
    """Reset the shared mock_db and install default dependency overrides before every test."""
    # DB override
    app.dependency_overrides[get_db_session] = override_get_db
    # Default JWT override (client-a)
    app.dependency_overrides[verify_user_jwt] = _jwt_client_a
    # Default permission override (client-a)
    RequirePermission.__call__ = _perm_client_a

    # Reset mock state
    mock_db.reset_mock()
    mock_db.execute.side_effect = None
    mock_db.execute.return_value = MagicMock()
    mock_db.commit.side_effect = None
    mock_db.commit.return_value = None
    mock_db.rollback.side_effect = None
    mock_db.rollback.return_value = None

    yield

    # Teardown
    RequirePermission.__call__ = _orig_require_permission_call
    app.dependency_overrides.pop(get_db_session, None)
    app.dependency_overrides.pop(verify_user_jwt, None)


# ---------------------------------------------------------------------------
# ── Helper builders ──────────────────────────────────────────────────────────
# ---------------------------------------------------------------------------

def _make_project_row(
    pid="proj-uuid-1",
    name="My Project",
    description="Test project",
    created_at="2026-06-01T00:00:00",
    updated_at="2026-06-01T00:00:00",
):
    row = MagicMock()
    row.id = pid
    row.name = name
    row.description = description
    row.created_at = created_at
    row.updated_at = updated_at
    return row


def _make_server_row(
    sid="srv-uuid-1",
    project_id="proj-uuid-1",
    hostname="server-01.internal",
    ip_address="10.0.0.1",
    status="online",
    specs=None,
    created_at="2026-06-01T00:00:00",
    updated_at="2026-06-01T00:00:00",
):
    row = MagicMock()
    row.id = sid
    row.project_id = project_id
    row.hostname = hostname
    row.ip_address = ip_address
    row.status = status
    row.specs = specs or {}
    row.created_at = created_at
    row.updated_at = updated_at
    return row


def _make_agent_row(
    aid="agent-uuid-1",
    server_id="srv-uuid-1",
    version="1.2.3",
    git_commit="abcdef1",
    status="active",
    capabilities_proof=None,
    last_connected_at="2026-06-01T01:00:00",
    created_at="2026-06-01T00:00:00",
    updated_at="2026-06-01T00:00:00",
):
    row = MagicMock()
    row.id = aid
    row.server_id = server_id
    row.version = version
    row.git_commit = git_commit
    row.status = status
    row.capabilities_proof = capabilities_proof or {}
    row.last_connected_at = last_connected_at
    row.created_at = created_at
    row.updated_at = updated_at
    return row


# ---------------------------------------------------------------------------
# ── FLOW 1: Full Tenant Lifecycle ────────────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_tenant_lifecycle_happy_path(monkeypatch):
    """
    Full lifecycle:
      1. Create project → 201
      2. Create server under that project → 201
      3. Brokered join (bootstrap) for that server → 200 + join_token
      4. List agents → 200 (empty list)
    """
    project_row = _make_project_row()
    server_row = _make_server_row()

    # Step 1 – Create Project
    # DB calls: set_tenant_search_path (implicit via execute) + INSERT project
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=project_row)),  # INSERT project RETURNING
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/projects/", json={"name": "My Project", "description": "Test project"})

    assert resp.status_code == 200, f"Create project failed: {resp.text}"
    data = resp.json()
    assert data["id"] == "proj-uuid-1"
    assert data["name"] == "My Project"
    mock_db.commit.assert_called_once()

    # Step 2 – Create Server
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=MagicMock())),  # project exists check
        MagicMock(fetchone=MagicMock(return_value=server_row)),   # INSERT server RETURNING
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            "/api/v1/servers/",
            json={
                "project_id": "proj-uuid-1",
                "hostname": "server-01.internal",
                "ip_address": "10.0.0.1",
            },
        )

    assert resp.status_code == 200, f"Create server failed: {resp.text}"
    srv_data = resp.json()
    assert srv_data["id"] == "srv-uuid-1"
    assert srv_data["hostname"] == "server-01.internal"
    mock_db.commit.assert_called_once()

    # Step 3 – Brokered Join (bootstrap)
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=server_row)),  # server exists in tenant
    ]

    monkeypatch.setattr("app.api.v1.endpoints.bootstrap.mint_sentinel_join_token",
                        lambda company_slug, server_id: "test-join-token-xyz")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/bootstrap/join", json={"server_id": "srv-uuid-1"})

    assert resp.status_code == 200, f"Bootstrap join failed: {resp.text}"
    join_data = resp.json()
    assert join_data["join_token"] == "test-join-token-xyz"
    assert join_data["client_id"] == "client-a.srv-uuid-1"

    # Step 4 – List Agents (empty)
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchall=MagicMock(return_value=[])),  # empty agent list
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 200, f"List agents failed: {resp.text}"
    assert resp.json() == []


# ---------------------------------------------------------------------------
# ── FLOW 2: Agent Commission Lifecycle ──────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_agent_commission_lifecycle(monkeypatch):
    """
    Agent commission lifecycle:
      1. List agents → 200 (1 active agent)
      2. Decommission agent → 200
      3. List agents → 200 (agent still present, now offline)
      4. Recommission agent → 200
    """
    active_agent = _make_agent_row(status="active")
    offline_agent = _make_agent_row(status="offline")

    mock_redis = AsyncMock()
    monkeypatch.setattr("redis.asyncio.from_url", lambda url, **kwargs: mock_redis)

    # Step 1 – List agents (1 active)
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchall=MagicMock(return_value=[active_agent])),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 200
    agents = resp.json()
    assert len(agents) == 1
    assert agents[0]["status"] == "active"

    # Step 2 – Decommission
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=MagicMock())),  # agent exists check
        AsyncMock(),  # UPDATE status to offline
        AsyncMock(),  # INSERT global audit log
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/agents/agent-uuid-1/decommission")

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    mock_db.commit.assert_called_once()
    mock_redis.set.assert_called_once_with("agent:revoked:agent-uuid-1", "true")

    # Step 3 – List agents (now offline)
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchall=MagicMock(return_value=[offline_agent])),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 200
    agents = resp.json()
    assert agents[0]["status"] == "offline"

    # Step 4 – Recommission
    mock_db.reset_mock()
    mock_redis.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=MagicMock())),  # agent exists check
        AsyncMock(),  # UPDATE status to active
        AsyncMock(),  # INSERT global audit log
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/agents/agent-uuid-1/recommission")

    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    mock_db.commit.assert_called_once()
    mock_redis.delete.assert_called_once_with("agent:revoked:agent-uuid-1")


# ---------------------------------------------------------------------------
# ── FLOW 3: Cross-Tenant Isolation ──────────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_cross_tenant_isolation_projects():
    """
    Tenant B cannot see Tenant A's projects.

    The design decision is: schema-level partitioning means Tenant B's search
    path points at client_client-b — Tenant A's rows are simply absent → 404 /
    empty list. The server should return an empty list, not Tenant A's data.
    """
    # Tenant A creates a project (DB returns row)
    project_row = _make_project_row()

    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-a)
        MagicMock(fetchone=MagicMock(return_value=project_row)),  # INSERT project
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/projects/", json={"name": "Tenant A Secret Project"})
    assert resp.status_code == 200

    # Switch to Tenant B context
    RequirePermission.__call__ = _perm_client_b

    # Tenant B lists projects → their schema is empty → []
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-b)
        MagicMock(fetchall=MagicMock(return_value=[])),  # empty for client-b
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/projects/")
    assert resp.status_code == 200
    assert resp.json() == [], "Tenant B should see no Tenant A projects"


@pytest.mark.asyncio
async def test_flow_cross_tenant_isolation_servers():
    """
    Tenant B cannot see Tenant A's servers (returns empty list).
    """
    RequirePermission.__call__ = _perm_client_b
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-b)
        MagicMock(fetchall=MagicMock(return_value=[])),  # no servers in client-b schema
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/servers/")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_flow_cross_tenant_isolation_server_create_project_not_found():
    """
    Tenant B cannot register a server under Tenant A's project.
    The project_id check runs in client-b schema → project not found → 404.
    """
    RequirePermission.__call__ = _perm_client_b
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-b)
        MagicMock(fetchone=MagicMock(return_value=None)),  # project NOT found in client-b schema
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            "/api/v1/servers/",
            json={
                "project_id": "proj-uuid-owned-by-client-a",
                "hostname": "attacker.internal",
                "ip_address": "192.168.1.1",
            },
        )
    assert resp.status_code == 404
    assert "Project not found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_cross_tenant_isolation_bootstrap_join():
    """
    Tenant B cannot get a join token for Tenant A's server.
    The server lookup runs in client-b schema → not found → 404.
    """
    app.dependency_overrides[verify_user_jwt] = _jwt_client_a

    # Override JWT to simulate client-b
    async def _jwt_client_b(request: Request = None, credentials=None):
        return {"sub": "user-b", "company_slug": "client-b", "tenant_id": "tenant-b-uuid"}

    app.dependency_overrides[verify_user_jwt] = _jwt_client_b
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-b)
        MagicMock(fetchone=MagicMock(return_value=None)),  # server not found in client-b schema
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/bootstrap/join", json={"server_id": "srv-uuid-owned-by-client-a"})

    assert resp.status_code == 404
    assert "not registered for client" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_cross_tenant_isolation_agents():
    """
    Tenant B cannot see Tenant A's agents (returns empty list).
    """
    RequirePermission.__call__ = _perm_client_b
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-b)
        MagicMock(fetchall=MagicMock(return_value=[])),  # no agents in client-b schema
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")
    assert resp.status_code == 200
    assert resp.json() == []


# ---------------------------------------------------------------------------
# ── FLOW 4: Project CRUD Error Paths ─────────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_project_duplicate_detection():
    """Creating a project with a duplicate name raises 409."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        Exception("duplicate key value violates unique constraint"),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/projects/", json={"name": "Existing Project"})

    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]
    mock_db.rollback.assert_called_once()


@pytest.mark.asyncio
async def test_flow_project_db_failure_500():
    """Unexpected DB error on project create returns 500."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        Exception("connection timeout"),
    ]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        resp = await ac.post("/api/v1/projects/", json={"name": "New Project"})

    assert resp.status_code == 500
    mock_db.rollback.assert_called_once()


@pytest.mark.asyncio
async def test_flow_project_list_db_failure_500():
    """Unexpected DB error on project list returns 500."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        Exception("schema does not exist"),
    ]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        resp = await ac.get("/api/v1/projects/")

    assert resp.status_code == 500


@pytest.mark.asyncio
async def test_flow_project_global_admin_missing_slug():
    """Global admin creating a project without company_slug param returns 400."""
    RequirePermission.__call__ = _perm_global

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/projects/", json={"name": "My Project"})

    assert resp.status_code == 400
    assert "Global administrator must target a specific company slug" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_project_global_admin_with_slug():
    """Global admin specifying company_slug creates project in that tenant's schema."""
    RequirePermission.__call__ = _perm_global
    project_row = _make_project_row(name="Delegated Project")

    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path for client-a (delegated)
        MagicMock(fetchone=MagicMock(return_value=project_row)),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            "/api/v1/projects/",
            json={"name": "Delegated Project", "company_slug": "client-a"},
        )

    assert resp.status_code == 200
    assert resp.json()["name"] == "Delegated Project"


@pytest.mark.asyncio
async def test_flow_project_invalid_slug_injection():
    """SQL-injection-like slugs are rejected with 400 before any DB call."""
    # Simulate a user somehow getting a crafted JWT slug through
    async def _perm_bad_slug(self, request: Request, db=None, api_key=None, credentials=None):
        return {"user_id": "u-x", "company_slug": "client-a; DROP SCHEMA", "tenant_id": "t-x"}

    RequirePermission.__call__ = _perm_bad_slug

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/projects/", json={"name": "Safe?"})

    assert resp.status_code == 400
    assert "Invalid tenant identifier" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# ── FLOW 5: Server CRUD Error Paths ──────────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_server_duplicate_detection():
    """Creating a server with duplicate hostname raises 409."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=MagicMock())),  # project exists
        Exception("duplicate key value violates unique constraint"),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            "/api/v1/servers/",
            json={"project_id": "proj-1", "hostname": "server-01.internal", "ip_address": "10.0.0.1"},
        )

    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]
    mock_db.rollback.assert_called_once()


@pytest.mark.asyncio
async def test_flow_server_project_not_found():
    """Registering a server for a non-existent project returns 404."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=None)),  # project NOT found
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            "/api/v1/servers/",
            json={"project_id": "ghost-proj", "hostname": "srv.internal", "ip_address": "10.0.0.2"},
        )

    assert resp.status_code == 404
    assert "Project not found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_server_list_happy_path():
    """Listing servers returns all servers in the tenant's schema."""
    rows = [
        _make_server_row(sid="srv-1", hostname="web-01.internal"),
        _make_server_row(sid="srv-2", hostname="db-01.internal"),
    ]
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchall=MagicMock(return_value=rows)),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/servers/")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    hostnames = {s["hostname"] for s in data}
    assert "web-01.internal" in hostnames
    assert "db-01.internal" in hostnames


@pytest.mark.asyncio
async def test_flow_server_list_db_failure():
    """DB failure on server list returns 500."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        Exception("timeout reading from servers table"),
    ]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        resp = await ac.get("/api/v1/servers/")

    assert resp.status_code == 500


@pytest.mark.asyncio
async def test_flow_server_global_admin_missing_slug():
    """Global admin listing servers without company_slug returns 400."""
    RequirePermission.__call__ = _perm_global

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/servers/")

    assert resp.status_code == 400
    assert "Global administrator must target a specific company slug" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_server_global_admin_with_slug():
    """Global admin specifying company_slug sees that tenant's servers."""
    RequirePermission.__call__ = _perm_global
    rows = [_make_server_row(sid="srv-9", hostname="tenant-a-box.internal")]
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchall=MagicMock(return_value=rows)),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/servers/?company_slug=client-a")

    assert resp.status_code == 200
    assert resp.json()[0]["hostname"] == "tenant-a-box.internal"


# ---------------------------------------------------------------------------
# ── FLOW 6: Agent Management Error Paths ─────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_agent_list_happy_path():
    """Listing agents returns all agents for the authenticated tenant."""
    rows = [
        _make_agent_row(aid="ag-1", status="active"),
        _make_agent_row(aid="ag-2", status="offline"),
    ]
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchall=MagicMock(return_value=rows)),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    statuses = {a["status"] for a in data}
    assert "active" in statuses
    assert "offline" in statuses


@pytest.mark.asyncio
async def test_flow_agent_list_db_failure():
    """DB failure on agent list returns 500."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        Exception("sentinel_agents table unreachable"),
    ]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 500


@pytest.mark.asyncio
async def test_flow_agent_list_global_scope_rejected():
    """Global admin calling list_agents without tenant context returns 400."""
    RequirePermission.__call__ = _perm_global

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 400
    assert "Scope mismatch" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_agent_decommission_not_found(monkeypatch):
    """Decommissioning a non-existent agent returns 404."""
    mock_redis = AsyncMock()
    monkeypatch.setattr("redis.asyncio.from_url", lambda url, **kwargs: mock_redis)

    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=None)),  # agent NOT found
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/agents/ghost-agent-id/decommission")

    assert resp.status_code == 404
    assert "Sentinel agent not found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_agent_recommission_not_found(monkeypatch):
    """Recommissioning a non-existent agent returns 404."""
    mock_redis = AsyncMock()
    monkeypatch.setattr("redis.asyncio.from_url", lambda url, **kwargs: mock_redis)

    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=None)),  # agent NOT found
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/agents/ghost-agent-id/recommission")

    assert resp.status_code == 404
    assert "Sentinel agent not found" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_agent_decommission_db_failure(monkeypatch):
    """DB failure during decommission (after agent found) causes rollback and 500."""
    mock_redis = AsyncMock()
    monkeypatch.setattr("redis.asyncio.from_url", lambda url, **kwargs: mock_redis)

    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=MagicMock())),  # agent found
        Exception("update failed: lock timeout"),  # UPDATE crashes
    ]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        resp = await ac.post("/api/v1/agents/agent-uuid-1/decommission")

    assert resp.status_code == 500
    mock_db.rollback.assert_called_once()


@pytest.mark.asyncio
async def test_flow_agent_scope_guard_invalid_slug():
    """Agents with SQL-injection slug are rejected before any DB operation."""
    async def _perm_injection_slug(self, request: Request, db=None, api_key=None, credentials=None):
        return {"user_id": "u-x", "company_slug": "client-a; DROP SCHEMA", "tenant_id": "t-x"}

    RequirePermission.__call__ = _perm_injection_slug

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/agents/")

    assert resp.status_code == 400
    assert "Invalid tenant identifier" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# ── FLOW 7: Bootstrap Join Error Paths ───────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_bootstrap_join_server_not_found():
    """Bootstrap join with unknown server_id returns 404."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=None)),  # server not found
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/bootstrap/join", json={"server_id": "ghost-server"})

    assert resp.status_code == 404
    assert "not registered for client" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_bootstrap_join_db_failure():
    """DB failure during bootstrap join returns 500."""
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path
        Exception("DB crash during server lookup"),
    ]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        resp = await ac.post("/api/v1/bootstrap/join", json={"server_id": "srv-1"})

    assert resp.status_code == 500
    assert "Control plane brokering error" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_flow_bootstrap_join_global_scope_rejected():
    """Bootstrap join from global admin context (without tenant) returns 400."""
    app.dependency_overrides[verify_user_jwt] = _jwt_global

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post("/api/v1/bootstrap/join", json={"server_id": "srv-1"})

    assert resp.status_code == 400
    assert "global administrator must target" in resp.json()["detail"].lower()


# ---------------------------------------------------------------------------
# ── FLOW 8: Global Admin Delegation Flows ────────────────────────────────────
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_flow_global_admin_list_projects_with_slug():
    """Global admin can list projects for a specific tenant using company_slug query param."""
    RequirePermission.__call__ = _perm_global
    rows = [_make_project_row(name="Client-A Project")]
    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-a)
        MagicMock(fetchall=MagicMock(return_value=rows)),
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.get("/api/v1/projects/?company_slug=client-a")

    assert resp.status_code == 200
    assert resp.json()[0]["name"] == "Client-A Project"


@pytest.mark.asyncio
async def test_flow_global_admin_register_server_for_tenant():
    """Global admin can register a server on behalf of a tenant using company_slug in body."""
    RequirePermission.__call__ = _perm_global
    server_row = _make_server_row(hostname="delegated-server.internal")

    mock_db.execute.side_effect = [
        AsyncMock(),  # set_tenant_search_path (client-a)
        MagicMock(fetchone=MagicMock(return_value=MagicMock())),  # project exists in client-a
        MagicMock(fetchone=MagicMock(return_value=server_row)),   # INSERT server
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        resp = await ac.post(
            "/api/v1/servers/",
            json={
                "project_id": "proj-uuid-1",
                "hostname": "delegated-server.internal",
                "ip_address": "172.16.0.1",
                "company_slug": "client-a",
            },
        )

    assert resp.status_code == 200
    assert resp.json()["hostname"] == "delegated-server.internal"
