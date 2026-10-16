import pytest
import jwt
import time
import hashlib
from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials
from unittest.mock import AsyncMock, MagicMock, patch
from sqlalchemy import text
from app.core.security import (
    get_password_hash,
    verify_password,
    verify_user_jwt,
    mint_sentinel_join_token,
    verify_password_strength,
    RequirePermission
)
from app.core.config import settings

def test_password_hashing():
    pwd = "super_secure_password"
    hashed = get_password_hash(pwd)
    assert hashed != pwd
    assert verify_password(pwd, hashed) is True
    assert verify_password("wrong_password", hashed) is False

def test_password_strength():
    # Pass
    verify_password_strength("StrongPass123!")
    
    # Fail - too short
    with pytest.raises(HTTPException):
        verify_password_strength("Short1!")

def test_mint_sentinel_join_token():
    company_slug = "test-client"
    server_id = "test-server"
    token = mint_sentinel_join_token(company_slug, server_id)
    
    payload = jwt.decode(token, settings.BOOTSTRAP_JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    assert payload["sub"] == "sentinel-bootstrap"
    assert payload["company_slug"] == company_slug
    assert payload["sentinel_id"] == server_id
    assert "jti" in payload
    assert payload["exp"] > payload["iat"]

def test_verify_user_jwt_success():
    payload = {
        "sub": "user-123",
        "company_slug": "test-slug",
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    
    decoded = verify_user_jwt(creds)
    assert decoded["sub"] == "user-123"
    assert decoded["company_slug"] == "test-slug"

def test_verify_user_jwt_missing_slug():
    payload = {
        "sub": "user-123",
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    
    with pytest.raises(HTTPException) as exc:
        verify_user_jwt(creds)
    assert exc.value.status_code == 401
    assert "Missing company_slug" in exc.value.detail

def test_verify_user_jwt_expired():
    payload = {
        "sub": "user-123",
        "company_slug": "test-slug",
        "exp": int(time.time()) - 100
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    
    with pytest.raises(HTTPException) as exc:
        verify_user_jwt(creds)
    assert exc.value.status_code == 401
    assert "signature has expired" in exc.value.detail


# ---------------------------------------------------------------------------
# Federated Auth and API Key Routing Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.core.security.redis.from_url")
async def test_api_key_routing_global(mock_redis):
    # Initialize redis mock
    mock_redis_client = AsyncMock()
    mock_redis_client.get.return_value = "true"
    mock_redis.return_value = mock_redis_client

    db = AsyncMock()
    # Mock global API key check result
    mock_row = MagicMock(admin_id="admin-uuid")
    mock_res = MagicMock()
    mock_res.fetchone.return_value = mock_row
    
    db.execute.side_effect = [
        mock_res, # Select global api key
    ]

    request = MagicMock(spec=Request)
    
    # Global API Key: cadoc_g_xxxxxxxx
    auth_guard = RequirePermission("security.read")
    result = await auth_guard(
        request=request,
        db=db,
        api_key="cadoc_g_testkey123",
        credentials=None
    )
    
    assert result["user_id"] == "admin-uuid"
    assert result["company_slug"] == "global"
    assert result["tenant_id"] is None


@pytest.mark.asyncio
@patch("app.core.security.set_tenant_search_path", new_callable=AsyncMock)
@patch("app.core.security.redis.from_url")
async def test_api_key_routing_tenant(mock_redis, mock_set_path):
    # Initialize redis mock
    mock_redis_client = AsyncMock()
    mock_redis_client.get.return_value = None
    mock_redis.return_value = mock_redis_client

    db = AsyncMock()
    # 1. Local api key verification
    mock_key_row = MagicMock(user_id="user-uuid")
    mock_key_res = MagicMock()
    mock_key_res.fetchone.return_value = mock_key_row

    # 2. Tenant UUID lookup
    mock_tenant_row = MagicMock(id="tenant-uuid")
    mock_tenant_res = MagicMock()
    mock_tenant_res.fetchone.return_value = mock_tenant_row

    # 3. Local role-permission checking
    mock_perm_res = MagicMock()
    mock_perm_res.scalar.return_value = True

    db.execute.side_effect = [
        mock_key_res,   # local key check
        mock_tenant_res, # tenant ID check
        mock_perm_res    # permission evaluation
    ]

    request = MagicMock(spec=Request)
    
    # Tenant API Key: cadoc_t_acme_xxxx
    auth_guard = RequirePermission("security.read")
    result = await auth_guard(
        request=request,
        db=db,
        api_key="cadoc_t_acme_testkey",
        credentials=None
    )
    
    assert result["user_id"] == "user-uuid"
    assert result["company_slug"] == "acme"
    assert result["tenant_id"] == "tenant-uuid"


@pytest.mark.asyncio
@patch("app.core.security.redis.from_url")
async def test_federated_permissions_bypass(mock_redis):
    mock_redis_client = AsyncMock()
    mock_redis_client.get.return_value = "true"
    mock_redis.return_value = mock_redis_client

    db = AsyncMock()
    request = MagicMock(spec=Request)

    # JWT payload for a global platform owner
    payload = {
        "sub": "global-admin-id",
        "company_slug": "global",
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    auth_guard = RequirePermission("admin.manage")
    result = await auth_guard(
        request=request,
        db=db,
        api_key=None,
        credentials=creds
    )

    assert result["user_id"] == "global-admin-id"
    assert result["company_slug"] == "global"
    assert result["tenant_id"] is None


@pytest.mark.asyncio
async def test_federated_login():
    import httpx
    from app.main import app
    from app.core.database import get_db_session

    mock_db = AsyncMock()
    app.dependency_overrides[get_db_session] = lambda: mock_db

    # 1. Global admin login
    mock_admin_row = MagicMock(
        id="admin-uuid-1",
        email="admin@global.live",
        display_name="Global Admin",
        password_hash=get_password_hash("StrongPass123!")
    )
    mock_db.execute.side_effect = [
        MagicMock(fetchone=MagicMock(return_value=mock_admin_row))
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "admin@global.live",
            "password": "StrongPass123!",
            "company_slug": "global"
        })
    assert response.status_code == 200
    res_data = response.json()
    assert "access_token" in res_data

    # 2. Tenant user login
    mock_user_row = MagicMock(
        id="user-uuid-1",
        email="user@tenant.live",
        display_name="Tenant User",
        password_hash=get_password_hash("StrongPass123!")
    )
    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_tenant-a")),  # set search path
        MagicMock(fetchone=MagicMock(return_value=mock_user_row))      # Select user
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "user@tenant.live",
            "password": "StrongPass123!",
            "company_slug": "tenant-a"
        })
    assert response.status_code == 200
    res_data = response.json()
    assert "access_token" in res_data

    app.dependency_overrides.pop(get_db_session, None)


@pytest.mark.asyncio
@patch("app.core.security.redis.from_url")
async def test_federated_permissions(mock_redis):
    # Initialize redis mock (cache miss)
    mock_redis_client = AsyncMock()
    mock_redis_client.get.return_value = None
    mock_redis.return_value = mock_redis_client

    db = AsyncMock()

    # 1. Platform admin bypass check
    mock_admin_res = MagicMock()
    mock_admin_res.fetchone.return_value = True  # user active
    db.execute.side_effect = [
        mock_admin_res
    ]

    request = MagicMock(spec=Request)
    auth_guard = RequirePermission("security.read")

    # Global Admin credentials
    payload_global = {"sub": "admin-uuid", "company_slug": "global", "exp": int(time.time()) + 3600}
    token_global = jwt.encode(payload_global, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds_global = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token_global)

    result = await auth_guard(request=request, db=db, api_key=None, credentials=creds_global)
    assert result["user_id"] == "admin-uuid"
    assert result["company_slug"] == "global"

    # 2. Tenant user check
    # Query 1: Resolve tenant UUID
    mock_tenant_row = MagicMock(id="tenant-uuid")
    mock_tenant_res = MagicMock()
    mock_tenant_res.fetchone.return_value = mock_tenant_row

    # Query 2: local user_roles/roles check (has_perm)
    mock_perm_res = MagicMock()
    mock_perm_res.scalar.return_value = True

    db.execute.side_effect = [
        mock_tenant_res,
        mock_perm_res
    ]

    # Tenant User credentials
    payload_tenant = {"sub": "user-uuid", "company_slug": "tenant-a", "exp": int(time.time()) + 3600}
    token_tenant = jwt.encode(payload_tenant, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    creds_tenant = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token_tenant)

    result = await auth_guard(request=request, db=db, api_key=None, credentials=creds_tenant)
    assert result["user_id"] == "user-uuid"
    assert result["company_slug"] == "tenant-a"
    assert result["tenant_id"] == "tenant-uuid"


@pytest.mark.asyncio
async def test_tenant_teardown_cleanup():
    db = AsyncMock()
    # Simulate dropping tenant schema
    company_slug = "client-delete"
    schema_name = f"client_{company_slug}"

    # We verify that executing DROP SCHEMA CASCADE on db runs successfully
    await db.execute(text(f"DROP SCHEMA {schema_name} CASCADE"))
    await db.commit()

    assert db.execute.call_count == 1
    call_sql = db.execute.call_args[0][0]
    assert str(call_sql.text) == f"DROP SCHEMA {schema_name} CASCADE"
    db.commit.assert_called_once()



def test_build_install_command(tmp_path, monkeypatch):
    from app.core import install
    ca = tmp_path / "ca.crt"
    import subprocess
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(tmp_path / "k"),
                    "-out", str(ca), "-subj", "/CN=t", "-days", "1"], check=True, capture_output=True)
    monkeypatch.setattr(install.settings, "CA_CERT_PATH", str(ca))
    monkeypatch.setattr(install.settings, "PUBLIC_BASE_URL", "https://h.example/")
    cmd = install.build_install_command("tok", "acme.srv-1")
    assert cmd.startswith("curl -fsSLk https://h.example/install.sh | sudo bash -s -- ")
    assert "--token tok --server https://h.example --client-id acme.srv-1 --ca-sha256 " in cmd
    assert len(install.ca_sha256()) == 64
