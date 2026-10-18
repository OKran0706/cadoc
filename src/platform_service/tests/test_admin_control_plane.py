import pytest
import jwt
import time
import hashlib
import json
import httpx
from unittest.mock import AsyncMock, MagicMock
from app.main import app
from app.core.config import settings
from app.core.database import get_db_session

# Unique local database session mock to prevent interference with other suites
local_mock_db = AsyncMock()

async def override_get_db_local():
    yield local_mock_db

@pytest.fixture(autouse=True)
def override_db_dependency():
    """Autouse fixture to reset the dependency override before each test, and perfectly restore it after."""
    old_override = app.dependency_overrides.get(get_db_session)
    app.dependency_overrides[get_db_session] = override_get_db_local
    yield
    if old_override is not None:
        app.dependency_overrides[get_db_session] = old_override
    else:
        app.dependency_overrides.pop(get_db_session, None)

def get_auth_headers(company_slug: str, permissions: list = None) -> dict:
    payload = {
        "sub": "user-123",
        "email": "admin@canary.sh",
        "display_name": "Test Admin",
        "company_slug": company_slug,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return {"Authorization": f"Bearer {token}"}

@pytest.mark.asyncio
async def test_auth_missing_credentials():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/keys/", headers={})
    assert response.status_code == 401
    assert "Missing administrative credentials" in response.json()["detail"]

@pytest.mark.asyncio
async def test_auth_invalid_api_key():
    local_mock_db.reset_mock()
    local_mock_db.execute.return_value = MagicMock(fetchone=MagicMock(return_value=None)) # invalid key lookup
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/keys/", headers={"X-API-Key": "invalid_key"})
    assert response.status_code == 401
    assert "Invalid or revoked API Key" in response.json()["detail"]

@pytest.mark.asyncio
async def test_api_keys_crud_success(monkeypatch):
    local_mock_db.reset_mock()
    
    # Mock Redis client
    mock_redis = AsyncMock()
    mock_redis.get.return_value = None # cache miss
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    # Mock tenant lookup, RBAC check, insert, and fetch
    mock_tenant_row = MagicMock(id="tenant-uuid-123")
    mock_insert_row = MagicMock(id="key-uuid-999", created_at="2026-05-21 12:00:00", expires_at="2026-05-31 12:00:00")
    
    # DB Queries executed sequentially:
    # 1. Resolve tenant uuid
    # 2. Check admin_has_permission
    # 3. Insert new api key
    local_mock_db.execute.side_effect = [
        MagicMock(fetchone=MagicMock(return_value=mock_tenant_row)), # tenant lookup
        MagicMock(scalar=MagicMock(return_value=True)), # permission check
        MagicMock(scalar=MagicMock(return_value="client_client-a")), # set_tenant_search_path
        MagicMock(fetchone=MagicMock(return_value=mock_insert_row)) # Insert key
    ]
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/keys/",
            json={"name": "test-prod-key", "expires_in_days": 10},
            headers=headers
        )
        
    assert response.status_code == 200
    res_data = response.json()
    assert res_data["id"] == "key-uuid-999"
    assert res_data["name"] == "test-prod-key"
    assert "cadoc_t_client-a_" in res_data["plain_text_key"]
    assert res_data["expires_at"] == "2026-05-31 12:00:00"

@pytest.mark.asyncio
async def test_decoys_listing_tenant_scoped(monkeypatch):
    local_mock_db.reset_mock()
    
    # Mock Redis
    mock_redis = AsyncMock()
    mock_redis.get.return_value = "true" # cache hit for security.read permission check
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    # Mock rows returning
    mock_decoy_row = MagicMock(
        id="decoy-uuid-1",
        server_id="server-uuid-1",
        hostname="web-01.internal",
        file_path="/var/www/html/login.php",
        decoy_type="web_page",
        original_hash="a"*64,
        status="planted",
        planted_at="2026-05-21 10:00:00",
        last_verified="2026-05-21 11:00:00",
        created_at="2026-05-21 10:00:00",
        updated_at="2026-05-21 11:00:00"
    )
    
    # DB Queries executed sequentially:
    # 1. Resolve tenant uuid
    # 2. Switch schema connection search path
    # 3. Select decoys list
    local_mock_db.execute.side_effect = [
        MagicMock(fetchone=MagicMock(return_value=MagicMock(id="tenant-uuid-123"))),
        MagicMock(scalar=MagicMock(return_value="client_client-a")),
        MagicMock(fetchall=MagicMock(return_value=[mock_decoy_row]))
    ]
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/decoys/", headers=headers)
        
    assert response.status_code == 200
    res_data = response.json()
    assert len(res_data) == 1
    assert res_data[0]["id"] == "decoy-uuid-1"
    assert res_data[0]["file_path"] == "/var/www/html/login.php"
    assert res_data[0]["hostname"] == "web-01.internal"
    assert res_data[0]["status"] == "planted"

@pytest.mark.asyncio
async def test_agent_decommission_lifecycle(monkeypatch):
    local_mock_db.reset_mock()
    
    # Mock Redis client
    mock_redis = AsyncMock()
    mock_redis.get.return_value = "true" # cached permission security.respond check
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    # DB Queries executed sequentially:
    # 1. Resolve tenant uuid
    # 2. Switch schema path
    # 3. Check agent exists
    # 4. Update agent status to offline
    # 5. Insert audit log
    local_mock_db.execute.side_effect = [
        MagicMock(fetchone=MagicMock(return_value=MagicMock(id="tenant-uuid-123"))),
        MagicMock(scalar=MagicMock(return_value="client_client-a")),
        MagicMock(fetchone=MagicMock(return_value=MagicMock(id="agent-uuid-456"))), # agent exists
        MagicMock(rowcount=1),
        MagicMock()
    ]
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/agents/agent-uuid-456/decommission", headers=headers)
        
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert "decommissioned" in response.json()["message"]
    
    # Verify blacklist key set in Redis
    mock_redis.set.assert_called_with("agent:revoked:agent-uuid-456", "true")
    # Status is 'decommissioned' (not just 'offline') so lists can filter it and liveness can't revive it
    update_sql = [str(c.args[0]) for c in local_mock_db.execute.call_args_list if "UPDATE" in str(c.args[0])]
    assert any("status = 'decommissioned'" in q for q in update_sql)


def test_liveness_never_revives_decommissioned_and_lists_hide_them():
    import inspect
    from app.services import liveness
    from app.api.v1.endpoints import servers, dashboard
    assert "NOT IN ('active', 'decommissioned')" in inspect.getsource(liveness.mark_agent_online)
    assert "NOT IN ('offline', 'decommissioned')" in inspect.getsource(liveness.mark_agent_offline)
    assert "status = 'decommissioned'" in inspect.getsource(servers.list_servers)
    assert "!= 'decommissioned'" in inspect.getsource(dashboard.list_agents)

@pytest.mark.asyncio
async def test_login_non_email_admin():
    local_mock_db.reset_mock()
    
    mock_user = MagicMock()
    mock_user.id = "admin-uuid-111"
    mock_user.email = "admin"
    mock_user.display_name = "Platform Admin"
    mock_user.password_hash = "$5$rounds=535000$GHaGLPjL7qbUKk8R$1mofac8g6jzkZE/7Xm0k2aG/E5WUkcimjmG.fRwU4Q9" # password is 'password'
    
    # DB Mock Queries executed sequentially:
    # 1. Fetch user
    # 2. Fetch tenant_id (none for global)
    local_mock_db.execute.side_effect = [
        MagicMock(fetchone=MagicMock(return_value=mock_user)),
        MagicMock(fetchone=MagicMock(return_value=None))
    ]
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "admin",
            "password": "password"
        })
        
    assert response.status_code == 200
    res_data = response.json()
    assert "access_token" in res_data
    assert res_data["token_type"] == "bearer"

from fastapi import HTTPException as FastAPIHTTPException
from app.core.security import verify_password_strength

def test_password_entropy_validation():
    # Weak passwords should raise HTTPException 400
    with pytest.raises(FastAPIHTTPException) as exc_info:
        verify_password_strength("weak")
    assert exc_info.value.status_code == 400
    assert "at least 12 characters" in exc_info.value.detail
    
    with pytest.raises(FastAPIHTTPException) as exc_info:
        verify_password_strength("Short1!")
    assert exc_info.value.status_code == 400
    
    with pytest.raises(FastAPIHTTPException) as exc_info:
        verify_password_strength("NOLOWERCASE123!")
    assert exc_info.value.status_code == 400
    
    with pytest.raises(FastAPIHTTPException) as exc_info:
        verify_password_strength("nouppercase123!")
    assert exc_info.value.status_code == 400
    
    with pytest.raises(FastAPIHTTPException) as exc_info:
        verify_password_strength("NoDigitsHere!!")
    assert exc_info.value.status_code == 400
    
    with pytest.raises(FastAPIHTTPException) as exc_info:
        verify_password_strength("NoSpecialChars123")
    assert exc_info.value.status_code == 400
    
    # Strong password should succeed silently
    verify_password_strength("P@ssw0rdStrengthTest!!")


@pytest.mark.asyncio
async def test_login_rate_limiter_bypasses_when_disabled(monkeypatch):
    monkeypatch.setattr(settings, "ENABLE_RATE_LIMIT", False)
    local_mock_db.reset_mock()
    # Clear any stale side_effect from previous tests and set a stable return_value
    local_mock_db.execute.side_effect = None
    local_mock_db.execute.return_value = MagicMock(fetchone=MagicMock(return_value=None))
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        for _ in range(10):
            response = await ac.post("/api/v1/auth/login", json={
                "email": "any_user@canary.sh",
                "password": "wrong_password"
            })
            assert response.status_code == 401


@pytest.mark.asyncio
async def test_login_rate_limiter_blocks_when_enabled(monkeypatch):
    monkeypatch.setattr(settings, "ENABLE_RATE_LIMIT", True)
    local_mock_db.reset_mock()
    # Use stable return_value (not side_effect list) so repeated calls don't exhaust
    local_mock_db.execute.side_effect = None
    local_mock_db.execute.return_value = MagicMock(fetchone=MagicMock(return_value=None))
    
    mock_redis = AsyncMock()
    mock_pipeline = AsyncMock()
    mock_redis.get.return_value = None
    
    attempts_count = 0
    async def mock_pipeline_execute():
        nonlocal attempts_count
        attempts_count += 1
        return [attempts_count, True, attempts_count, True]
        
    mock_pipeline.execute = mock_pipeline_execute
    mock_redis.pipeline.return_value.__aenter__ = AsyncMock(return_value=mock_pipeline)
    mock_redis.pipeline.return_value.__aexit__ = AsyncMock(return_value=False)
    
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        for _ in range(5):
            response = await ac.post("/api/v1/auth/login", json={
                "email": "target@canary.sh",
                "password": "wrong"
            })
            assert response.status_code == 401
            
        # Simulate lockout being set after 5 failures
        mock_redis.get.return_value = "locked"
        
        response = await ac.post("/api/v1/auth/login", json={
            "email": "target@canary.sh",
            "password": "wrong"
        })
        assert response.status_code == 429
        assert "Too many failed login attempts" in response.json()["detail"]


@pytest.mark.asyncio
async def test_decoys_server_filter_binds_uuid_and_composes_with_status():
    local_mock_db.reset_mock()
    sid = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f"
    local_mock_db.execute.side_effect = None
    local_mock_db.execute.return_value = MagicMock(
        fetchone=MagicMock(return_value=MagicMock(id="tenant-uuid-123")),
        fetchall=MagicMock(return_value=[]), scalar=MagicMock(return_value="client_client-a"))
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        bad = await ac.get("/api/v1/decoys/?server_id=not-a-uuid", headers=headers)
        ok = await ac.get(f"/api/v1/decoys/?server_id={sid}&status=planted", headers=headers)
    assert bad.status_code == 422  # never reaches SQL
    assert ok.status_code == 200
    q = [c for c in local_mock_db.execute.call_args_list if "canary_decoy_files" in str(c.args[0])][-1]
    assert "status = :status AND server_id = COALESCE(" in str(q.args[0])  # resolves merged-agent aliases
    assert "CAST(:server_id AS uuid))" in str(q.args[0])
    assert q.args[1] == {"status": "planted", "server_id": sid}
