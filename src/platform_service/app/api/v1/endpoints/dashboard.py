import base64
import json
import asyncio
import re
import redis.asyncio as redis
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
from app.core.config import settings
from app.core.database import get_db_session, set_tenant_search_path
from app.core.security import verify_user_jwt, RequirePermission, mint_sentinel_join_token
import time
import csv
import io

router = APIRouter()

class AlertPayload(BaseModel):
    id: str
    server_id: str
    event_type: str
    severity: str
    details: dict
    detected_at: str

class PagedAlertsResponse(BaseModel):
    data: list[AlertPayload]
    next_cursor: Optional[str]
    has_more: bool

@router.get("/alerts", response_model=PagedAlertsResponse)
async def get_alerts(
    cursor: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(verify_user_jwt)
):
    """
    Exposes high-speed, partition-pruned cursor-paginated security alerts.
    Pruning is accomplished by forcing range comparisons directly on detected_at.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
    
    await set_tenant_search_path(db, company_slug)

    # Defaults: query the last 30 days of data to trigger partition pruning
    pruning_limit = "AND detected_at >= (now() - INTERVAL '30 days')"
    cursor_timestamp = None
    cursor_id = None

    # Parse cursor if present
    if cursor:
        try:
            decoded = base64.b64decode(cursor.encode("utf-8")).decode("utf-8")
            # Expected format: "2026-05-17T22:15:00+00:00||some-uuid-id"
            ts_str, cid = decoded.split("||")
            cursor_timestamp = datetime.fromisoformat(ts_str)
            cursor_id = cid
            # When paginate, search backwards from cursor point (newer to older)
            pruning_limit = "AND detected_at <= :cursor_ts AND (detected_at < :cursor_ts OR id < :cursor_id)"
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid cursor payload mapping")

    # Dynamic cursor query execution
    # Prunes unused monthly tables by directly searching partition key detected_at
    sql = f"""
        SELECT id, server_id, event_type, severity, details, detected_at::text
        FROM "client_{company_slug}".tamper_alerts
        WHERE 1=1
        {pruning_limit}
        ORDER BY detected_at DESC, id DESC
        LIMIT :limit_plus_one
    """

    params = {"limit_plus_one": limit + 1}
    if cursor_timestamp:
        params["cursor_ts"] = cursor_timestamp
        params["cursor_id"] = cursor_id

    result = await db.execute(text(sql), params)
    rows = result.fetchall()

    has_more = len(rows) > limit
    data_rows = rows[:limit]

    next_cursor = None
    if has_more and data_rows:
        last_row = data_rows[-1]
        raw_cursor = f"{last_row.detected_at}||{last_row.id}"
        next_cursor = base64.b64encode(raw_cursor.encode("utf-8")).decode("utf-8")

    alerts_list = [
        AlertPayload(
            id=str(r.id),
            server_id=str(r.server_id),
            event_type=r.event_type,
            severity=r.severity,
            details=r.details,
            detected_at=r.detected_at
        ) for r in data_rows
    ]

    return PagedAlertsResponse(data=alerts_list, next_cursor=next_cursor, has_more=has_more)


class AgentResponse(BaseModel):
    id: str
    server_id: str
    version: Optional[str]
    git_commit: Optional[str]
    status: str
    last_connected_at: Optional[str]


@router.get("/agents", response_model=list[AgentResponse])
async def list_agents(
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(verify_user_jwt)
):
    """
    Exposes high-speed, direct database query of registered tenant agents.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
    
    await set_tenant_search_path(db, company_slug)
    
    # Safety check to prevent SQL injection
    if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")

    sql = f"""
        SELECT id, server_id, version, git_commit, status, last_connected_at::text
        FROM "client_{company_slug}".sentinel_agents
        ORDER BY last_connected_at DESC NULLS LAST, id DESC
    """
    result = await db.execute(text(sql))
    rows = result.fetchall()

    return [
        AgentResponse(
            id=str(r.id),
            server_id=str(r.server_id),
            version=r.version,
            git_commit=r.git_commit,
            status=r.status,
            last_connected_at=r.last_connected_at
        ) for r in rows
    ]


@router.get("/agents/metrics")
async def get_agents_metrics(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(verify_user_jwt)
):
    """
    Streams live telemetry metrics from Redis for the registered agents of the tenant in real-time.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
    
    async def event_generator():
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            while True:
                if await request.is_disconnected():
                    break
                
                await set_tenant_search_path(db, company_slug)
                
                # Safety check to prevent SQL injection
                if not re.match(r"^[a-zA-Z0-9_-]+$", company_slug):
                    break

                sql = f"""
                    SELECT id, server_id, status FROM "client_{company_slug}".sentinel_agents
                """
                result = await db.execute(text(sql))
                agents = result.fetchall()
                
                metrics_payload = {}
                for agent in agents:
                    agent_id = agent.id
                    status = agent.status
                    
                    redis_key = f"agent:heartbeat:{company_slug}:{agent_id}"
                    heartbeat_val = await r.get(redis_key)
                    
                    metrics = None
                    if heartbeat_val:
                        try:
                            hb_data = json.loads(heartbeat_val)
                            metrics = hb_data.get("metrics")
                        except Exception:
                            pass
                    
                    metrics_payload[str(agent_id)] = {
                        "server_id": str(agent.server_id),
                        "status": status,
                        "metrics": metrics
                    }
                
                yield f"data: {json.dumps(metrics_payload)}\n\n"
                await asyncio.sleep(2)
                
        except asyncio.CancelledError:
            pass
        finally:
            await r.close()
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")


# --- NEW TELEMETRY & DASHBOARD ENDPOINTS ---

class MitigatePayload(BaseModel):
    notes: Optional[str] = None

@router.post("/alerts/{alert_id}/mitigate")
async def mitigate_alert(
    alert_id: str,
    payload: MitigatePayload,
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("security.respond"))
):
    """
    Manually mitigates a critical security incident. Telemetry is append-only in client_{company_slug}.alert_mitigations.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    # Verify target alert exists
    alert_stmt = text(f"SELECT id FROM \"client_{company_slug}\".tamper_alerts WHERE id = :alert_id LIMIT 1")
    res = await db.execute(alert_stmt, {"alert_id": alert_id})
    alert = res.fetchone()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
        
    # Append mitigation log
    insert_stmt = text(f"""
        INSERT INTO "client_{company_slug}".alert_mitigations (alert_id, analyst_user_id, mitigation_notes)
        VALUES (:alert_id, :analyst_id, :notes)
        ON CONFLICT (alert_id) DO NOTHING
    """)
    await db.execute(insert_stmt, {
        "alert_id": alert_id,
        "analyst_id": admin_claims["user_id"],
        "notes": payload.notes
    })
    await db.commit()
    
    return {"status": "success", "message": "Incident successfully mitigated"}


class SummaryKPIsResponse(BaseModel):
    criticalAlerts: int
    mitigatedIncidents: int
    activeAnalysts: int
    networkUptime: str | float


@router.get("/summary", response_model=SummaryKPIsResponse)
async def get_summary_kpis(
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("security.read"))
):
    """
    Fetches the four top-level KPI cards for the tenant's security dashboard.
    """
    company_slug = admin_claims["company_slug"]
    tenant_id = admin_claims["tenant_id"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    # 1. Critical Alerts (unmitigated, critical severity)
    crit_stmt = text(f"""
        SELECT COUNT(*) 
        FROM "client_{company_slug}".tamper_alerts 
        WHERE severity = 'critical' 
          AND id NOT IN (SELECT alert_id FROM "client_{company_slug}".alert_mitigations)
    """)
    crit_res = await db.execute(crit_stmt)
    critical_alerts = crit_res.scalar() or 0
    
    # 2. Mitigated Incidents (rows in alert_mitigations)
    mit_stmt = text(f"SELECT COUNT(*) FROM \"client_{company_slug}\".alert_mitigations")
    mit_res = await db.execute(mit_stmt)
    mitigated_incidents = mit_res.scalar() or 0
    
    # 3. Active Analysts (distinct analyst users assigned to this tenant)
    analysts_stmt = text(f"""
        SELECT COUNT(DISTINCT id) 
        FROM "client_{company_slug}".users
    """)
    analysts_res = await db.execute(analysts_stmt)
    active_analysts = analysts_res.scalar() or 0
    
    # 4. Network Uptime
    agents_stmt = text(f"""
        SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'active') as active 
        FROM "client_{company_slug}".sentinel_agents
    """)
    agents_res = await db.execute(agents_stmt)
    agents_row = agents_res.fetchone()
    
    total_agents = agents_row.total if agents_row else 0
    active_agents = agents_row.active if agents_row else 0
    
    if total_agents == 0:
        network_uptime = "N/A"
    else:
        network_uptime = round((active_agents / total_agents) * 100, 2)
        
    return SummaryKPIsResponse(
        criticalAlerts=critical_alerts,
        mitigatedIncidents=mitigated_incidents,
        activeAnalysts=active_analysts,
        networkUptime=network_uptime
    )


class NodeInventoryResponse(BaseModel):
    id: str
    location: str
    ip: str
    status: str
    cpu: Optional[float]
    memoryUsed: Optional[float]
    memoryTotal: Optional[float]
    threats: int


@router.get("/nodes", response_model=list[NodeInventoryResponse])
async def list_nodes_inventory(
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("security.read"))
):
    """
    Fetches the node list, combining DB metadata and live Redis heartbeats.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    sql = f"""
        SELECT 
            a.id as agent_id,
            s.id as server_id,
            s.hostname,
            s.ip_address::text as ip,
            COALESCE(s.specs->>'location', 'Unknown') as location,
            a.status as agent_status,
            (
                SELECT COUNT(*) 
                FROM "client_{company_slug}".tamper_alerts ta
                WHERE ta.server_id = s.id 
                  AND ta.id NOT IN (SELECT alert_id FROM "client_{company_slug}".alert_mitigations)
            ) as threats
        FROM "client_{company_slug}".sentinel_agents a
        JOIN "client_{company_slug}".servers s ON s.id = a.server_id
        ORDER BY s.hostname ASC
    """
    result = await db.execute(text(sql))
    rows = result.fetchall()
    
    r = redis.from_url(settings.REDIS_URL, decode_responses=True)
    nodes = []
    
    try:
        for row in rows:
            redis_key = f"agent:heartbeat:{company_slug}:{row.agent_id}"
            heartbeat_val = await r.get(redis_key)
            
            status = "offline"
            cpu = None
            memory_used = None
            memory_total = None
            
            if heartbeat_val:
                try:
                    hb_data = json.loads(heartbeat_val)
                    metrics = hb_data.get("metrics")
                    if metrics:
                        status = "online"
                        cpu = metrics.get("cpu_percent")
                        mem_percent = metrics.get("memory_percent")
                        memory_total = metrics.get("memory_total")
                        if mem_percent is not None and memory_total is not None:
                            memory_used = round((mem_percent / 100) * memory_total, 2)
                except Exception:
                    pass
            
            nodes.append(NodeInventoryResponse(
                id=str(row.agent_id),
                location=row.location,
                ip=row.ip,
                status=status,
                cpu=cpu,
                memoryUsed=memory_used,
                memoryTotal=memory_total,
                threats=row.threats
            ))
    finally:
        await r.close()
        
    return nodes


class HeatmapCellResponse(BaseModel):
    id: str
    hostname: str
    location: str
    project: str
    row: int
    col: int
    intensity: int


@router.get("/detections/heatmap", response_model=list[HeatmapCellResponse])
async def get_detections_heatmap(
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("security.read"))
):
    """
    Generates a virtual 2D grid containing risk intensities mapped geographically.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    sql = f"""
        SELECT 
            s.id as server_id,
            s.hostname,
            COALESCE(s.specs->>'location', 'Unknown') as location,
            p.name as project_name,
            (
                SELECT COUNT(*) 
                FROM "client_{company_slug}".tamper_alerts ta
                WHERE ta.server_id = s.id 
                  AND ta.id NOT IN (SELECT alert_id FROM "client_{company_slug}".alert_mitigations)
            ) as threats
        FROM "client_{company_slug}".servers s
        JOIN "client_{company_slug}".projects p ON p.id = s.project_id
        ORDER BY COALESCE(s.specs->>'location', 'Unknown') ASC, p.name ASC, s.hostname ASC
    """
    res = await db.execute(text(sql))
    servers = res.fetchall()
    
    n = len(servers)
    if n == 0:
        return []
        
    # Smallest square D x D >= n
    import math
    d = math.ceil(math.sqrt(n))
    
    cells = []
    for i, s in enumerate(servers):
        row = i // d
        col = i % d
        cells.append(HeatmapCellResponse(
            id=str(s.server_id),
            hostname=s.hostname,
            location=s.location,
            project=s.project_name,
            row=row,
            col=col,
            intensity=s.threats
        ))
        
    return cells


class JoinRequest(BaseModel):
    server_id: str

class JoinResponse(BaseModel):
    token: str
    expires_at: int
    install_command: str


@router.post("/servers/token", response_model=JoinResponse)
async def generate_join_token(
    payload: JoinRequest,
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("cmdb.write"))
):
    """
    Generates brokered join tokens and outputs installation commands.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    # Check server exists
    server_stmt = text(f"SELECT id FROM \"client_{company_slug}\".servers WHERE id = :server_id LIMIT 1")
    res = await db.execute(server_stmt, {"server_id": payload.server_id})
    server = res.fetchone()
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
        
    client_id = f"sentinel-agent-{company_slug}"
    join_token = mint_sentinel_join_token(client_id, payload.server_id)
    expires_at = int(time.time()) + 900
    install_cmd = f"curl -sSL https://cadoc.io/install.sh | bash -s -- --token {join_token}"
    
    return JoinResponse(
        token=join_token,
        expires_at=expires_at,
        install_command=install_cmd
    )


class VerifyRequest(BaseModel):
    server_id: str

class VerifyResponse(BaseModel):
    verified: bool
    status: str


@router.post("/servers/verify", response_model=VerifyResponse)
async def verify_server_registration(
    payload: VerifyRequest,
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("cmdb.read"))
):
    """
    Checks if a server is registered successfully.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    agent_stmt = text(f"SELECT id, status FROM \"client_{company_slug}\".sentinel_agents WHERE server_id = :server_id LIMIT 1")
    res = await db.execute(agent_stmt, {"server_id": payload.server_id})
    agent = res.fetchone()
    
    verified = False
    status = "not_registered"
    
    if agent:
        status = agent.status
        verified = (agent.status == "active")
        
    return VerifyResponse(verified=verified, status=status)


@router.get("/reports/export")
async def export_telemetry_csv(
    db: AsyncSession = Depends(get_db_session),
    admin_claims: dict = Depends(RequirePermission("security.read"))
):
    """
    Queries database metrics and streams dynamic CSV report.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    await set_tenant_search_path(db, company_slug)
    
    sql = f"""
        SELECT 
            s.id as server_id,
            s.hostname,
            s.ip_address::text as ip,
            COALESCE(s.specs->>'location', 'Unknown') as location,
            s.status as server_status,
            (
                SELECT COUNT(*) 
                FROM "client_{company_slug}".tamper_alerts ta
                WHERE ta.server_id = s.id 
                  AND ta.severity = 'critical'
                  AND ta.id NOT IN (SELECT alert_id FROM "client_{company_slug}".alert_mitigations)
            ) as critical_alerts,
            (
                SELECT COUNT(*) 
                FROM "client_{company_slug}".alert_mitigations am
                JOIN "client_{company_slug}".tamper_alerts ta ON ta.id = am.alert_id
                WHERE ta.server_id = s.id
            ) as mitigated_incidents
        FROM "client_{company_slug}".servers s
        ORDER BY s.hostname ASC
    """
    res = await db.execute(text(sql))
    rows = res.fetchall()
    
    agents_sql = f"SELECT id, server_id FROM \"client_{company_slug}\".sentinel_agents"
    agents_res = await db.execute(text(agents_sql))
    agents_rows = agents_res.fetchall()
    server_agent_map = {str(a.server_id): str(a.id) for a in agents_rows}
    
    async def generate_csv():
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "Node ID", "Hostname", "IP Address", "Location", 
            "Registered Status", "CPU", "Memory", "Critical Alerts", "Mitigated Incidents"
        ])
        yield output.getvalue()
        output.truncate(0)
        output.seek(0)
        
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        try:
            for row in rows:
                agent_id = server_agent_map.get(str(row.server_id))
                cpu = ""
                mem = ""
                
                if agent_id:
                    redis_key = f"agent:heartbeat:{company_slug}:{agent_id}"
                    heartbeat_val = await r.get(redis_key)
                    if heartbeat_val:
                        try:
                            hb_data = json.loads(heartbeat_val)
                            metrics = hb_data.get("metrics")
                            if metrics:
                                cpu = f"{metrics.get('cpu_percent', '')}%"
                                mem_percent = metrics.get('memory_percent')
                                memory_total = metrics.get('memory_total')
                                if mem_percent is not None and memory_total is not None:
                                    memory_used = round((mem_percent / 100) * memory_total, 2)
                                    mem = f"{memory_used} GB / {memory_total} GB"
                        except Exception:
                            pass
                            
                writer.writerow([
                    str(row.server_id),
                    row.hostname,
                    row.ip,
                    row.location,
                    row.server_status,
                    cpu,
                    mem,
                    row.critical_alerts,
                    row.mitigated_incidents
                ])
                yield output.getvalue()
                output.truncate(0)
                output.seek(0)
        finally:
            await r.close()
            
    headers = {
        "Content-Disposition": "attachment; filename=telemetry_report.csv",
        "Content-Type": "text/csv"
    }
    return StreamingResponse(generate_csv(), headers=headers)


@router.get("/alerts/stream")
async def get_alerts_stream(
    request: Request,
    admin_claims: dict = Depends(RequirePermission("security.read"))
):
    """
    Provides multi-tenant real-time security alert feeds using Redis Pub/Sub SSE stream.
    """
    company_slug = admin_claims["company_slug"]
    if company_slug == "global":
        raise HTTPException(status_code=400, detail="Scope mismatch: Endpoint requires tenant authorization context")
        
    async def event_generator():
        r = redis.from_url(settings.REDIS_URL, decode_responses=True)
        pubsub = r.pubsub()
        await pubsub.subscribe(f"tenant:{company_slug}:alerts")
        try:
            while True:
                if await request.is_disconnected():
                    break
                    
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message:
                    try:
                        payload = json.loads(message["data"])
                        yield f"data: {json.dumps(payload)}\n\n"
                    except Exception:
                        pass
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(f"tenant:{company_slug}:alerts")
            await pubsub.close()
            await r.close()
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")

