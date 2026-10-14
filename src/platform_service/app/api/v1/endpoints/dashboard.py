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
from app.core.security import verify_user_jwt

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
        FROM client_{company_slug}.tamper_alerts
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
        FROM client_{company_slug}.sentinel_agents
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
                    SELECT id, server_id, status FROM client_{company_slug}.sentinel_agents
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
