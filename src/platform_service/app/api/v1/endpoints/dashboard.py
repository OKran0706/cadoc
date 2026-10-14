import base64
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from pydantic import BaseModel
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
        FROM tamper_alerts
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
