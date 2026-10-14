import pytest
import jwt
import time
import base64
import httpx
from unittest.mock import AsyncMock, MagicMock
from app.main import app
from app.core.config import settings
from app.core.database import get_db_session

# Global mock DB session for FastAPI dependency overrides
mock_db = AsyncMock()

async def override_get_db():
    yield mock_db

app.dependency_overrides[get_db_session] = override_get_db

def get_auth_headers(company_slug: str) -> dict:
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
async def test_health_endpoint():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"

@pytest.mark.asyncio
async def test_login_endpoint():
    mock_db.reset_mock()
    
    # Mock select admin_users
    mock_user = MagicMock()
    mock_user.id = "user-123"
    mock_user.email = "admin@canary.sh"
    mock_user.display_name = "Test Admin"
    # Using sha256_crypt hash for password "password"
    mock_user.password_hash = "$5$rounds=535000$GHaGLPjL7qbUKk8R$1mofac8g6jzkZE/7Xm0k2aG/E5WUkcimjmG.fRwU4Q9"
    
    mock_db.execute.side_effect = [
        MagicMock(fetchone=MagicMock(return_value=mock_user)), # Select user
        MagicMock(fetchone=MagicMock(return_value=MagicMock(slug="tenant-a"))) # Select tenant role
    ]
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post("/api/v1/auth/login", json={
            "email": "admin@canary.sh",
            "password": "password"
        })
    assert response.status_code == 200
    assert "access_token" in response.json()
    assert response.json()["token_type"] == "bearer"

@pytest.mark.asyncio
async def test_provision_tenant_unauthorized():
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/onboarding/provision",
            json={"slug": "client-b", "name": "Client B Inc"},
            headers=headers
        )
    assert response.status_code == 403
    assert "platform credentials" in response.json()["detail"]

@pytest.mark.asyncio
async def test_provision_tenant_success():
    mock_db.reset_mock()
    mock_db.execute.side_effect = None
    mock_db.execute.return_value = MagicMock(scalar=MagicMock(return_value="tenant-uuid-5678"))
    
    headers = get_auth_headers("global")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/onboarding/provision",
            json={"slug": "client-b", "name": "Client B Inc"},
            headers=headers
        )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["tenant_id"] == "tenant-uuid-5678"

@pytest.mark.asyncio
async def test_brokered_join_ambiguous_global():
    headers = get_auth_headers("global")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/bootstrap/join",
            json={"server_id": "server-1234"},
            headers=headers
        )
    assert response.status_code == 400
    assert "Ambiguous context" in response.json()["detail"]

@pytest.mark.asyncio
async def test_brokered_join_success():
    mock_db.reset_mock()
    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_client-a")), # set search path
        MagicMock(fetchone=MagicMock(return_value=MagicMock(id="server-1234", hostname="prod-node-1"))) # Select server
    ]
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/bootstrap/join",
            json={"server_id": "server-1234"},
            headers=headers
        )
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert "join_token" in response.json()
    assert response.json()["client_id"] == "sentinel-agent-client-a"

@pytest.mark.asyncio
async def test_dashboard_alerts_without_cursor():
    mock_db.reset_mock()
    mock_alert_row = MagicMock(
        id="alert-uuid-1",
        server_id="server-uuid-1",
        event_type="UNAUTHORIZED_FILE_TAMPER",
        severity="high",
        details={"path": "/etc/shadow"},
        detected_at="2026-05-17T22:15:00+00:00"
    )
    
    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_client-a")), # set search path
        MagicMock(fetchall=MagicMock(return_value=[mock_alert_row])) # Select alerts
    ]
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/alerts", headers=headers)
    assert response.status_code == 200
    res_data = response.json()
    assert len(res_data["data"]) == 1
    assert res_data["data"][0]["id"] == "alert-uuid-1"
    assert res_data["next_cursor"] is None
    assert res_data["has_more"] is False

@pytest.mark.asyncio
async def test_dashboard_alerts_with_cursor_pagination():
    mock_db.reset_mock()
    mock_row_1 = MagicMock(
        id="alert-uuid-1",
        server_id="server-uuid-1",
        event_type="TAMPER",
        severity="high",
        details={},
        detected_at="2026-05-17T22:15:00+00:00"
    )
    mock_row_2 = MagicMock(
        id="alert-uuid-2",
        server_id="server-uuid-1",
        event_type="TAMPER",
        severity="medium",
        details={},
        detected_at="2026-05-17T22:10:00+00:00"
    )
    
    mock_db.execute.side_effect = [
        MagicMock(scalar=MagicMock(return_value="client_client-a")), # set search path
        MagicMock(fetchall=MagicMock(return_value=[mock_row_1, mock_row_2])) # 2 rows for limit=1
    ]
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/alerts?limit=1", headers=headers)
    assert response.status_code == 200
    res_data = response.json()
    assert len(res_data["data"]) == 1
    assert res_data["has_more"] is True
    assert res_data["next_cursor"] is not None
    
    decoded = base64.b64decode(res_data["next_cursor"].encode("utf-8")).decode("utf-8")
    assert "2026-05-17T22:15:00+00:00||alert-uuid-1" in decoded
