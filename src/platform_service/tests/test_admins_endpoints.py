"""
Integration tests for the /api/v1/admins/* endpoints.

Auth sequence for Bearer JWT with company_slug='global':
  - JWT decoded in-memory (no DB call)
  - company_slug='global' -> tenant_id resolution skipped
  - 1 DB call: admin_has_permission scalar
  Then endpoint-specific DB calls follow.
"""
import pytest
import jwt
import time
import httpx
from unittest.mock import AsyncMock, MagicMock, patch
from app.main import app
from app.core.config import settings
from app.core.database import get_db_session

# Session mock that properly handles commit/rollback as coroutines
mock_db = AsyncMock()
mock_db.commit = AsyncMock()
mock_db.rollback = AsyncMock()

async def override_db():
    yield mock_db

@pytest.fixture(autouse=True)
def isolate_db():
    old = app.dependency_overrides.get(get_db_session)
    app.dependency_overrides[get_db_session] = override_db
    # Reset BEFORE each test so previous test's side_effects don't bleed through
    mock_db.reset_mock()
    mock_db.execute = AsyncMock()
    mock_db.commit = AsyncMock()
    mock_db.rollback = AsyncMock()
    # Always mock Redis to return cache miss so the RBAC permission DB call is never skipped
    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.set = AsyncMock(return_value=True)
    with patch("app.core.security.redis.from_url", return_value=mock_redis):
        yield
    if old is not None:
        app.dependency_overrides[get_db_session] = old
    else:
        app.dependency_overrides.pop(get_db_session, None)

def admin_headers(company_slug: str = "global") -> dict:
    payload = {
        "sub": "caller-admin-uuid",
        "email": "superadmin@canary.sh",
        "company_slug": company_slug,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600,
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return {"Authorization": f"Bearer {token}"}


def perm_ok():
    """Mock for admin_has_permission → scalar returns True."""
    m = MagicMock()
    m.scalar = MagicMock(return_value=True)
    return m

def rows(*items):
    m = MagicMock()
    m.fetchall = MagicMock(return_value=list(items))
    return m

def row(obj):
    m = MagicMock()
    m.fetchone = MagicMock(return_value=obj)
    m.rowcount = 1
    return m

def no_row():
    m = MagicMock()
    m.fetchone = MagicMock(return_value=None)
    m.rowcount = 0
    return m

def affected(n):
    m = MagicMock()
    m.rowcount = n
    m.fetchone = MagicMock(return_value=None)
    return m

def schema_switch():
    m = MagicMock()
    m.scalar = MagicMock(return_value="client_client-a")
    return m


def make_row(**kwargs):
    """Create a MagicMock with _mapping dict access and attribute access."""
    obj = MagicMock()
    for k, v in kwargs.items():
        setattr(obj, k, v)
    obj._mapping = kwargs
    return obj


# ---------------------------------------------------------------------------
# List Admins
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_admins():
    admin_row = make_row(
        id="admin-uuid-1", email="alice@canary.sh",
        display_name="Alice", status="active",
        auth_provider="local", created_at="2026-01-01T00:00:00",
        roles=["platform_owner"]
    )
    mock_db.execute.side_effect = [perm_ok(), rows(admin_row)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/admins/", headers=admin_headers())

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert data[0]["email"] == "alice@canary.sh"
    assert "platform_owner" in data[0]["roles"]


# ---------------------------------------------------------------------------
# Create Admin
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_admin_weak_password():
    mock_db.execute.side_effect = [perm_ok()]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/admins/", headers=admin_headers(), json={
            "email": "bob@canary.sh",
            "display_name": "Bob",
            "password": "weak"
        })

    assert response.status_code == 400
    assert "12 characters" in response.json()["detail"]


@pytest.mark.asyncio
async def test_create_admin_success():
    new_row = make_row(
        id="new-admin-uuid", email="bob@canary.sh",
        display_name="Bob", status="active",
        auth_provider="local", created_at="2026-01-01T00:00:00"
    )
    mock_db.execute.side_effect = [perm_ok(), row(new_row)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/admins/", headers=admin_headers(), json={
            "email": "bob@canary.sh",
            "display_name": "Bob",
            "password": "Str0ng!AdminP@ss"
        })

    assert response.status_code == 200
    data = response.json()
    assert data["email"] == "bob@canary.sh"
    assert data["status"] == "active"


# ---------------------------------------------------------------------------
# Status Update
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_update_status_self_lockout_blocked():
    mock_db.execute.side_effect = [perm_ok()]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.patch(
            "/api/v1/admins/caller-admin-uuid/status",
            headers=admin_headers(),
            json={"status": "disabled"}
        )

    assert response.status_code == 400
    assert "self-lockout" in response.json()["detail"]


@pytest.mark.asyncio
async def test_update_status_success():
    mock_db.execute.side_effect = [perm_ok(), affected(1)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.patch(
            "/api/v1/admins/other-admin-uuid/status",
            headers=admin_headers(),
            json={"status": "disabled"}
        )

    assert response.status_code == 200
    assert response.json()["status"] == "success"


@pytest.mark.asyncio
async def test_update_status_invalid_value():
    mock_db.execute.side_effect = [perm_ok()]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.patch(
            "/api/v1/admins/other-admin-uuid/status",
            headers=admin_headers(),
            json={"status": "banned"}
        )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# Roles Registry
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_roles():
    role1 = make_row(
        id="role-uuid-1", name="platform_owner",
        scope="global", description="Full admin",
        permissions=["admin.manage", "audit.read"]
    )
    role2 = make_row(
        id="role-uuid-2", name="tenant_admin",
        scope="tenant", description="Tenant admin",
        permissions=["cmdb.read", "cmdb.write"]
    )
    mock_db.execute.side_effect = [perm_ok(), rows(role1, role2)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/admins/roles", headers=admin_headers())

    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    assert data[0]["name"] == "platform_owner"
    assert "admin.manage" in data[0]["permissions"]
    assert data[1]["scope"] == "tenant"


# ---------------------------------------------------------------------------
# Role Assignment
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_assign_role_global_success():
    assign_row = make_row(id="assignment-uuid-1")
    mock_db.execute.side_effect = [
        perm_ok(),
        row(make_row(id="role-uuid-1", scope="global")),   # role lookup
        row(assign_row)                                      # INSERT
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/admins/target-admin-uuid/roles",
            headers=admin_headers(),
            json={"role_name": "platform_owner"}
        )

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert "user_role_id" in response.json()


@pytest.mark.asyncio
async def test_assign_global_role_with_slug_rejected():
    """Global roles must not specify company_slug — scope guard rejects it."""
    mock_db.execute.side_effect = [
        perm_ok(),
        row(make_row(id="role-uuid-1", scope="global")),   # role lookup
        row(make_row(id="tenant-uuid-1"))                   # tenant slug lookup
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/admins/target-admin-uuid/roles",
            headers=admin_headers(),
            json={"role_name": "platform_owner", "company_slug": "client-a"}
        )

    assert response.status_code == 400
    assert "Global roles" in response.json()["detail"]


@pytest.mark.asyncio
async def test_assign_tenant_role_without_slug_rejected():
    """Tenant-scoped roles require company_slug."""
    mock_db.execute.side_effect = [
        perm_ok(),
        row(make_row(id="role-uuid-2", scope="tenant"))   # role lookup
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/admins/target-admin-uuid/roles",
            headers=admin_headers(),
            json={"role_name": "tenant_admin"}
        )

    assert response.status_code == 400
    assert "require a company_slug" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Role Revocation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_revoke_role_success():
    mock_db.execute.side_effect = [perm_ok(), affected(1)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.delete(
            "/api/v1/admins/target-admin-uuid/roles/assignment-uuid-1",
            headers=admin_headers()
        )

    assert response.status_code == 200
    assert response.json()["status"] == "success"


@pytest.mark.asyncio
async def test_revoke_role_not_found():
    mock_db.execute.side_effect = [perm_ok(), affected(0)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.delete(
            "/api/v1/admins/target-admin-uuid/roles/nonexistent-uuid",
            headers=admin_headers()
        )

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Audit Logs
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_audit_logs():
    audit_row = make_row(
        id=1, tenant_id="tenant-uuid-1", tenant_slug="client-a",
        event_type="sentinel.alert", payload={"severity": "high"},
        created_at="2026-01-01T00:00:00", admin_email="admin@canary.sh"
    )
    mock_db.execute.side_effect = [perm_ok(), rows(audit_row)]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/admins/audit-logs", headers=admin_headers())

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert data[0]["event_type"] == "sentinel.alert"
    assert data[0]["tenant_slug"] == "client-a"


# ---------------------------------------------------------------------------
# Client Telemetry
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_clients():
    tenant_row = make_row(
        id="t-uuid-1", slug="client-a", name="Client A",
        status="active", created_at="2026-01-01T00:00:00"
    )
    counts_row = make_row(
        server_count=3, active_agent_count=2,
        planted_decoy_count=5, alert_count=1
    )
    mock_db.execute.side_effect = [
        perm_ok(),
        rows(tenant_row),       # tenant list
        row(counts_row)         # aggregate counts (schema-qualified, no search_path call)
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/admins/clients", headers=admin_headers())

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert data[0]["slug"] == "client-a"
    assert data[0]["server_count"] == 3
    assert data[0]["active_agent_count"] == 2
    assert data[0]["planted_decoy_count"] == 5


@pytest.mark.asyncio
async def test_get_client_detail_not_found():
    mock_db.execute.side_effect = [
        perm_ok(),
        no_row()    # tenant lookup → None → 404
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/admins/clients/nonexistent", headers=admin_headers())

    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


@pytest.mark.asyncio
async def test_get_client_detail_success():
    tenant_row = make_row(
        id="t-uuid-1", slug="client-a", name="Client A",
        status="active", created_at="2026-01-01T00:00:00"
    )
    srv_row = make_row(
        id="srv-uuid-1", hostname="srv-test", ip_address="192.168.1.100",
        os_type="Linux", status="online", created_at="2026-01-01T00:00:00"
    )
    agent_row = make_row(
        id="ag-uuid-1", server_id="srv-uuid-1", status="active",
        version="v1.5.0", last_seen_at="2026-01-01T00:01:00", created_at="2026-01-01T00:00:00"
    )
    decoy_row = make_row(
        id="decoy-uuid-1", server_id="srv-uuid-1", file_path="/etc/passwd",
        file_type="honeyfile", status="planted", planted_at="2026-01-01T00:02:00"
    )
    alert_row = make_row(
        id="alt-uuid-1", server_id="srv-uuid-1", file_path="/etc/passwd",
        alert_type="DECOY_TAMPER", severity="high", triggered_at="2026-01-01T00:03:00",
        resolved_at=None
    )
    mock_db.execute.side_effect = [
        perm_ok(),
        row(tenant_row),        # tenant lookup
        rows(srv_row),          # servers
        rows(agent_row),        # agents
        rows(decoy_row),        # decoys
        rows(alert_row)         # alerts
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/admins/clients/client-a", headers=admin_headers())

    assert response.status_code == 200
    data = response.json()
    assert data["tenant"]["slug"] == "client-a"
    assert "servers" in data
    assert "sentinel_agents" in data
    assert "decoy_files" in data
    assert "recent_alerts" in data
    
    # Assert nesting works correctly
    first_srv = data["servers"][0]
    assert first_srv["id"] == "srv-uuid-1"
    assert first_srv["sentinel_agents"][0]["id"] == "ag-uuid-1"
    assert first_srv["decoy_files"][0]["id"] == "decoy-uuid-1"
    assert first_srv["recent_alerts"][0]["id"] == "alt-uuid-1"
