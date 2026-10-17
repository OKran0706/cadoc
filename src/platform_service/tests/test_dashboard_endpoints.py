import pytest
import jwt
import time
import base64
import json
import httpx
from unittest.mock import AsyncMock, MagicMock
from app.main import app
from app.core.config import settings
from app.core.database import get_db_session
from app.core.security import RequirePermission

# Global mock DB session for FastAPI dependency overrides
mock_db = AsyncMock()

async def override_get_db():
    yield mock_db

# Override RequirePermission auth guard to return dummy credentials for client-a
from fastapi import Request

async def dummy_require_permission(self, request: Request):
    return {
        "user_id": "user-uuid-123",
        "company_slug": "client-a",
        "tenant_id": "tenant-uuid-123"
    }

_original_require_permission_call = RequirePermission.__call__

@pytest.fixture(autouse=True)
def isolate_dashboard_tests():
    # Backup old overrides
    old_db_override = app.dependency_overrides.get(get_db_session)
    
    # Set the override
    app.dependency_overrides[get_db_session] = override_get_db
    
    # Patch RequirePermission
    RequirePermission.__call__ = dummy_require_permission
    
    # Reset mock db
    mock_db.reset_mock()
    
    yield
    
    # Restore RequirePermission
    RequirePermission.__call__ = _original_require_permission_call
    
    # Restore overrides
    if old_db_override is not None:
        app.dependency_overrides[get_db_session] = old_db_override
    else:
        app.dependency_overrides.pop(get_db_session, None)

def get_auth_headers(company_slug: str) -> dict:
    payload = {
        "sub": "user-uuid-123",
        "email": "admin@canary.sh",
        "display_name": "Test Admin",
        "company_slug": company_slug,
        "iat": int(time.time()),
        "exp": int(time.time()) + 3600
    }
    token = jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)
    return {"Authorization": f"Bearer {token}"}

@pytest.mark.asyncio
async def test_summary_kpi_zero_agents():
    mock_db.reset_mock()
    
    # 0 agents case
    # Mocking:
    # 1. set search path
    # 2. critical count
    # 3. mitigated count
    # 4. active analysts
    # 5. total_agents / active_agents
    
    mock_crit = MagicMock(scalar=MagicMock(return_value=14))
    mock_mit = MagicMock(scalar=MagicMock(return_value=2841))
    mock_analysts = MagicMock(scalar=MagicMock(return_value=12))
    
    mock_agents_count = MagicMock()
    mock_agents_count.fetchone.return_value = MagicMock(total=0, active=0)
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "tamper_alerts" in stmt_str:
            return mock_crit
        elif "alert_mitigations" in stmt_str:
            return mock_mit
        elif "users" in stmt_str:
            return mock_analysts
        elif "sentinel_agents" in stmt_str:
            return mock_agents_count
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/summary", headers=headers)
        
    assert response.status_code == 200
    res_data = response.json()
    assert res_data["criticalAlerts"] == 14
    assert res_data["mitigatedIncidents"] == 2841
    assert res_data["activeAnalysts"] == 12
    assert res_data["networkUptime"] == "N/A"


@pytest.mark.asyncio
async def test_summary_kpi_with_agents():
    mock_db.reset_mock()
    
    mock_crit = MagicMock(scalar=MagicMock(return_value=5))
    mock_mit = MagicMock(scalar=MagicMock(return_value=10))
    mock_analysts = MagicMock(scalar=MagicMock(return_value=3))
    
    mock_agents_count = MagicMock()
    mock_agents_count.fetchone.return_value = MagicMock(total=5, active=4)
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "tamper_alerts" in stmt_str:
            return mock_crit
        elif "alert_mitigations" in stmt_str:
            return mock_mit
        elif "users" in stmt_str:
            return mock_analysts
        elif "sentinel_agents" in stmt_str:
            return mock_agents_count
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/summary", headers=headers)
        
    assert response.status_code == 200
    res_data = response.json()
    assert res_data["criticalAlerts"] == 5
    assert res_data["mitigatedIncidents"] == 10
    assert res_data["activeAnalysts"] == 3
    assert res_data["networkUptime"] == 80.0


@pytest.mark.asyncio
async def test_mitigation_lifecycle():
    mock_db.reset_mock()
    alert_uuid = "00000000-0000-0000-0000-000000000001"
    
    # 1. Mock alert exists checks, then insertion
    mock_alert_row = MagicMock(id=alert_uuid)
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "tamper_alerts" in stmt_str:
            return MagicMock(fetchone=MagicMock(return_value=mock_alert_row))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            f"/api/v1/dashboard/alerts/{alert_uuid}/mitigate",
            json={"notes": "Checked. False positive."},
            headers=headers
        )
        
    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert "mitigated" in response.json()["message"].lower()


@pytest.mark.asyncio
async def test_mitigation_not_found():
    mock_db.reset_mock()
    alert_uuid = "00000000-0000-0000-0000-000000000002"
    
    # Mock alert doesn't exist
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "tamper_alerts" in stmt_str:
            return MagicMock(fetchone=MagicMock(return_value=None))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            f"/api/v1/dashboard/alerts/{alert_uuid}/mitigate",
            json={"notes": "Checked. False positive."},
            headers=headers
        )
        
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_nodes_inventory(monkeypatch):
    mock_db.reset_mock()
    
    # Mock server + agent records
    mock_node_row_1 = MagicMock(
        agent_id="sentinel-uuid-1",
        server_id="server-uuid-1",
        hostname="frankfurt-node-1",
        ip="192.168.1.10",
        location="Frankfurt, DE",
        status="active",
        threats=2
    )
    mock_node_row_2 = MagicMock(
        agent_id="sentinel-uuid-2",
        server_id="server-uuid-2",
        hostname="paris-node-2",
        ip="192.168.1.20",
        location="Paris, FR",
        status="offline",
        threats=0
    )
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "sentinel_agents" in stmt_str or "servers" in stmt_str:
            return MagicMock(fetchall=MagicMock(return_value=[mock_node_row_1, mock_node_row_2]))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    # Mock Redis client
    mock_redis = AsyncMock()
    # Mock first key present, second key expired/missing
    async def get_side_effect(key):
        if "sentinel-uuid-1" in key:
            return json.dumps({
                "metrics": {
                    "cpu_percent": 12.4,
                    "memory_percent": 26.25,
                    "memory_total": 16.0
                }
            })
        return None
        
    mock_redis.get.side_effect = get_side_effect
    
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/nodes", headers=headers)
        
    assert response.status_code == 200
    res_data = response.json()
    assert len(res_data) == 2
    
    # Check node 1 (online, heartbeating)
    node1 = next(x for x in res_data if x["id"] == "sentinel-uuid-1")
    assert node1["status"] == "online"
    assert node1["cpu"] == 12.4
    assert node1["memoryUsed"] == 4.2  # (26.25 / 100) * 16.0 = 4.2
    assert node1["memoryTotal"] == 16.0
    assert node1["threats"] == 2
    
    # Check node 2 (offline, missing heartbeat)
    node2 = next(x for x in res_data if x["id"] == "sentinel-uuid-2")
    assert node2["status"] == "offline"
    assert node2["cpu"] is None
    assert node2["memoryUsed"] is None
    assert node2["memoryTotal"] is None
    assert node2["threats"] == 0


@pytest.mark.asyncio
async def test_heatmap():
    mock_db.reset_mock()
    
    # Sized dynamically as smallest D*D >= N.
    # E.g. N = 5 -> D = 3.
    mock_server_1 = MagicMock(server_id="server-1", hostname="node-a", location="Frankfurt, DE", project_name="Proj-X", threats=0)
    mock_server_2 = MagicMock(server_id="server-2", hostname="node-b", location="Frankfurt, DE", project_name="Proj-Y", threats=3)
    mock_server_3 = MagicMock(server_id="server-3", hostname="node-c", location="London, UK", project_name="Proj-X", threats=1)
    mock_server_4 = MagicMock(server_id="server-4", hostname="node-d", location="London, UK", project_name="Proj-Z", threats=0)
    mock_server_5 = MagicMock(server_id="server-5", hostname="node-e", location="New York, US", project_name="Proj-A", threats=10)
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "servers" in stmt_str:
            return MagicMock(fetchall=MagicMock(return_value=[
                mock_server_1, mock_server_2, mock_server_3, mock_server_4, mock_server_5
            ]))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/detections/heatmap", headers=headers)
        
    assert response.status_code == 200
    res_data = response.json()
    
    # 5 nodes -> 3x3 grid size -> cols=3, rows=3
    assert len(res_data) == 5
    
    # Frankfurt, DE should come first alphabetically, then London, UK, then New York, US.
    # Grouping ensures sequential placement. Let's inspect coordinates.
    # Index 0: Frankfurt Proj-X node-a -> (0, 0)
    # Index 1: Frankfurt Proj-Y node-b -> (0, 1)
    # Index 2: London Proj-X node-c -> (0, 2)
    # Index 3: London Proj-Z node-d -> (1, 0)
    # Index 4: New York Proj-A node-e -> (1, 1)
    
    n0 = res_data[0]
    assert n0["id"] == "server-1"
    assert n0["row"] == 0
    assert n0["col"] == 0
    assert n0["intensity"] == 0
    
    n4 = res_data[4]
    assert n4["id"] == "server-5"
    assert n4["row"] == 1
    assert n4["col"] == 1
    assert n4["intensity"] == 10


@pytest.mark.asyncio
async def test_onboarding_verification():
    mock_db.reset_mock()
    server_uuid = "00000000-0000-0000-0000-000000000009"
    
    # POST /servers/token
    mock_server_row = MagicMock(id=server_uuid, hostname="prod-node-x")
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "servers" in stmt_str:
            return MagicMock(fetchone=MagicMock(return_value=mock_server_row))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/dashboard/servers/token",
            json={"server_id": server_uuid},
            headers=headers
        )
        
    assert response.status_code == 200
    res_data = response.json()
    assert "token" in res_data
    assert "install_command" in res_data
    assert "--token" in res_data["install_command"]
    
    # POST /servers/verify
    # Mocking check:
    # Row indicating active status
    mock_agent_row = MagicMock(status="active")
    
    def execute_side_effect_verify(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "sentinel_agents" in stmt_str:
            return MagicMock(fetchone=MagicMock(return_value=mock_agent_row))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect_verify
    
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.post(
            "/api/v1/dashboard/servers/verify",
            json={"server_id": server_uuid},
            headers=headers
        )
        
    assert response.status_code == 200
    assert response.json()["status"] == "active"
    assert response.json()["verified"] is True


@pytest.mark.asyncio
async def test_csv_export(monkeypatch):
    mock_db.reset_mock()
    
    mock_redis = AsyncMock()
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.close = AsyncMock()
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    # Mock server listing database query
    mock_row_1 = MagicMock(
        id="server-1",
        hostname="node-1",
        ip_address="192.168.1.10",
        location="Frankfurt, DE",
        status="active",
        cpu=12.4,
        memory=4.2,
        critical_alerts=2,
        mitigated_incidents=1
    )
    
    def execute_side_effect(statement, params=None, *args, **kwargs):
        stmt_str = str(statement).lower()
        if "set search_path" in stmt_str:
            return MagicMock(scalar=MagicMock(return_value="client_client-a"))
        elif "servers" in stmt_str or "sentinel_agents" in stmt_str:
            return MagicMock(fetchall=MagicMock(return_value=[mock_row_1]))
        return MagicMock()
        
    mock_db.execute.side_effect = execute_side_effect
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        response = await ac.get("/api/v1/dashboard/reports/export", headers=headers)
        
    assert response.status_code == 200
    assert response.headers["Content-Disposition"] == "attachment; filename=telemetry_report.csv"
    assert "text/csv" in response.headers["Content-Type"]
    
    content = response.text
    assert "Node ID" in content
    assert "node-1" in content
    assert "Frankfurt, DE" in content


@pytest.mark.asyncio
async def test_sse_stream(monkeypatch):
    from unittest.mock import MagicMock
    mock_redis = AsyncMock()
    
    # Mock PubSub listener
    mock_pubsub = AsyncMock()
    mock_pubsub.get_message.side_effect = [
        {"type": "message", "data": json.dumps({"alert_id": "uuid-1", "severity": "critical"})},
        None # to simulate wait
    ]
    
    mock_redis.pubsub = MagicMock(return_value=mock_pubsub)
    
    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    
    from fastapi import Request
    monkeypatch.setattr(Request, "is_disconnected", AsyncMock(side_effect=[False, True]))
    
    import asyncio
    async def mock_sleep(delay):
        return
    monkeypatch.setattr(asyncio, "sleep", mock_sleep)
    
    headers = get_auth_headers("client-a")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        async with ac.stream("GET", "/api/v1/dashboard/alerts/stream", headers=headers) as response:
            assert response.status_code == 200
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    data = json.loads(line[5:])
                    assert data["alert_id"] == "uuid-1"
                    assert data["severity"] == "critical"
                    break


@pytest.mark.asyncio
async def test_sse_stream_server_filter(monkeypatch):
    from unittest.mock import MagicMock
    mine, other = "34d0222e-5f7b-4b7f-b1be-023377ec8f8f", "11111111-1111-4111-8111-111111111111"
    mock_redis = AsyncMock()
    mock_pubsub = AsyncMock()
    mock_pubsub.get_message.side_effect = [
        {"type": "message", "data": json.dumps({"type": "heartbeat", "server_id": other})},
        {"type": "message", "data": json.dumps({"type": "alert", "server_id": mine})},
        None,
    ]
    mock_redis.pubsub = MagicMock(return_value=mock_pubsub)

    import redis.asyncio as aioredis
    monkeypatch.setattr(aioredis, "from_url", lambda url, **kwargs: mock_redis)
    from fastapi import Request
    monkeypatch.setattr(Request, "is_disconnected", AsyncMock(side_effect=[False, False, True]))

    import asyncio
    async def mock_sleep(delay):
        return
    monkeypatch.setattr(asyncio, "sleep", mock_sleep)

    headers = get_auth_headers("client-a")
    seen = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as ac:
        async with ac.stream("GET", f"/api/v1/dashboard/alerts/stream?server_id={mine}", headers=headers) as response:
            assert response.status_code == 200
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    seen.append(json.loads(line[5:]))
    assert [m["server_id"] for m in seen] == [mine]  # the other server's heartbeat was filtered out
