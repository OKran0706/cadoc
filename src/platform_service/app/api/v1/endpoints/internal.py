"""Service-to-service routes (ingestion -> platform). Not for admins or sentinels.

The ingestion service verifies the sentinel's mTLS identity and passes the tenant/server it
derived from the certificate. These routes trust that, so they are guarded by a shared token
and fail closed when none is configured.
"""
import hmac
import logging
import re
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db_session, set_tenant_search_path

logger = logging.getLogger("platform.internal")
router = APIRouter()

_SLUG = re.compile(r"^[a-zA-Z0-9_-]+$")


def require_internal_token(x_internal_token: Optional[str] = Header(default=None)) -> None:
    expected = settings.INTERNAL_API_TOKEN
    if not expected:
        raise HTTPException(status_code=503, detail="Internal API disabled")
    if not x_internal_token:
        raise HTTPException(status_code=401, detail="Missing internal token")
    if not hmac.compare_digest(x_internal_token.encode(), expected.encode()):
        raise HTTPException(status_code=403, detail="Invalid internal token")


class CanaryItem(BaseModel):
    id: str
    path: str
    type: str
    sha256: str
    status: str


class CanaryList(BaseModel):
    canaries: List[CanaryItem]


@router.get(
    "/tenants/{slug}/servers/{server_id}/canaries",
    response_model=CanaryList,
    dependencies=[Depends(require_internal_token)],
)
async def list_server_canaries(
    slug: str,
    server_id: UUID,
    db: AsyncSession = Depends(get_db_session),
):
    """Planted/tampered/orphaned canaries the sentinel on this server should remove."""
    if slug == "global" or not _SLUG.match(slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")
    try:
        await set_tenant_search_path(db, slug)
        result = await db.execute(
            text(f"""
                SELECT id, file_path, decoy_type, original_hash, status
                FROM "client_{slug}".canary_decoy_files
                WHERE server_id = COALESCE(
                          (SELECT a.server_id FROM "client_{slug}".server_aliases a WHERE a.alias_id = CAST(:sid AS uuid)),
                          CAST(:sid AS uuid))
                  AND status IN ('planted', 'tampered', 'orphaned')
                ORDER BY planted_at, id
            """),
            {"sid": str(server_id)},
        )
        rows = result.fetchall()
    except Exception:
        logger.exception("INTERNAL_CANARIES_FAILED slug=%s server=%s", slug, server_id)
        raise HTTPException(status_code=500, detail="Failed to read canary registry")
    return CanaryList(canaries=[
        CanaryItem(id=str(r.id), path=r.file_path, type=r.decoy_type, sha256=r.original_hash, status=r.status)
        for r in rows
    ])


class ActionResult(BaseModel):
    alert_id: UUID
    ok: bool
    message: str = ""


@router.post(
    "/tenants/{slug}/servers/{server_id}/actions/result",
    dependencies=[Depends(require_internal_token)],
)
async def report_action_result(
    slug: str,
    server_id: UUID,
    body: ActionResult,
    db: AsyncSession = Depends(get_db_session),
):
    """Sentinel's outcome for a queued process quarantine; only moves a pending request on this server's alert."""
    if slug == "global" or not _SLUG.match(slug):
        raise HTTPException(status_code=400, detail="Invalid tenant identifier")
    try:
        await set_tenant_search_path(db, slug)
        result = await db.execute(
            text(f"""
                UPDATE "client_{slug}".alert_mitigations m
                SET status = :status, result_msg = :msg, updated_at = now()
                WHERE m.alert_id = CAST(:aid AS uuid)
                  AND m.status = 'QUARANTINE_REQUESTED'
                  AND EXISTS (
                      SELECT 1 FROM "client_{slug}".tamper_alerts t
                      WHERE t.id = m.alert_id
                        AND t.server_id = COALESCE(
                              (SELECT a.server_id FROM "client_{slug}".server_aliases a WHERE a.alias_id = CAST(:sid AS uuid)),
                              CAST(:sid AS uuid)))
            """),
            {
                "status": "QUARANTINED" if body.ok else "QUARANTINE_FAILED",
                "msg": body.message[:300],
                "aid": str(body.alert_id),
                "sid": str(server_id),
            },
        )
        await db.commit()
    except Exception:
        logger.exception("INTERNAL_ACTION_RESULT_FAILED slug=%s server=%s", slug, server_id)
        raise HTTPException(status_code=500, detail="Failed to record action result")
    return {"updated": result.rowcount}
