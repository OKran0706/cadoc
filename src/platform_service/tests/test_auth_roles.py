import pytest
import jwt
import httpx
from unittest.mock import AsyncMock, MagicMock
from app.main import app
from app.core.config import settings
from app.core.database import get_db_session
from app.core.security import get_password_hash


@pytest.mark.asyncio
async def test_login_global_admin_returns_role():
    mock_db = AsyncMock()
    app.dependency_overrides[get_db_session] = lambda: mock_db

    mock_admin_row = MagicMock(
        id="admin-uuid-1",
        email="admin@global.live",
        display_name="Global Admin",
        password_hash=get_password_hash("StrongPass123!"),
        role="platform_owner"
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
    assert res_data["token_type"] == "bearer"
    assert res_data["role"] == "platform_owner"
    assert res_data["roles"] == ["platform_owner"]

    decoded = jwt.decode(res_data["access_token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    assert decoded["role"] == "platform_owner"
    assert decoded["roles"] == ["platform_owner"]
    assert decoded["email"] == "admin@global.live"

    app.dependency_overrides.pop(get_db_session, None)


@pytest.mark.asyncio
async def test_login_tenant_user_returns_assigned_roles():
    mock_db = AsyncMock()
    app.dependency_overrides[get_db_session] = lambda: mock_db

    mock_user_row = MagicMock(
        id="user-uuid-1",
        email="alice@tenant.live",
        display_name="Alice Admin",
        password_hash=get_password_hash("StrongPass123!"),
        roles=["tenant-admin"]
    )
    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_tenant-a")),
        MagicMock(fetchone=MagicMock(return_value=mock_user_row))
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "alice@tenant.live",
            "password": "StrongPass123!",
            "company_slug": "tenant-a"
        })

    assert response.status_code == 200
    res_data = response.json()
    assert res_data["role"] == "tenant-admin"
    assert res_data["roles"] == ["tenant-admin"]

    decoded = jwt.decode(res_data["access_token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    assert decoded["role"] == "tenant-admin"
    assert decoded["roles"] == ["tenant-admin"]
    assert decoded["company_slug"] == "tenant-a"

    app.dependency_overrides.pop(get_db_session, None)


@pytest.mark.asyncio
async def test_login_tenant_user_multiple_roles():
    mock_db = AsyncMock()
    app.dependency_overrides[get_db_session] = lambda: mock_db

    mock_user_row = MagicMock(
        id="user-uuid-2",
        email="bob@tenant.live",
        display_name="Bob Security",
        password_hash=get_password_hash("StrongPass123!"),
        roles=["security-analyst", "audit-viewer"]
    )
    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_tenant-a")),
        MagicMock(fetchone=MagicMock(return_value=mock_user_row))
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "bob@tenant.live",
            "password": "StrongPass123!",
            "company_slug": "tenant-a"
        })

    assert response.status_code == 200
    res_data = response.json()
    assert res_data["role"] == "security-analyst"
    assert res_data["roles"] == ["security-analyst", "audit-viewer"]

    decoded = jwt.decode(res_data["access_token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    assert decoded["role"] == "security-analyst"
    assert decoded["roles"] == ["security-analyst", "audit-viewer"]

    app.dependency_overrides.pop(get_db_session, None)


@pytest.mark.asyncio
async def test_login_tenant_user_fallback_default_role():
    mock_db = AsyncMock()
    app.dependency_overrides[get_db_session] = lambda: mock_db

    mock_user_row = MagicMock(
        id="user-uuid-3",
        email="carol@tenant.live",
        display_name="Carol NoRole",
        password_hash=get_password_hash("StrongPass123!"),
        roles=None,
        role=None
    )
    # Configure roles to be None, not a MagicMock
    mock_user_row.roles = None
    mock_user_row.role = None

    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_tenant-a")),
        MagicMock(fetchone=MagicMock(return_value=mock_user_row))
    ]

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "carol@tenant.live",
            "password": "StrongPass123!",
            "company_slug": "tenant-a"
        })

    assert response.status_code == 200
    res_data = response.json()
    assert res_data["role"] == "user"
    assert res_data["roles"] == ["user"]

    decoded = jwt.decode(res_data["access_token"], settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    assert decoded["role"] == "user"
    assert decoded["roles"] == ["user"]

    app.dependency_overrides.pop(get_db_session, None)
